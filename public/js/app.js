// SkyHonix Workspace Application Logic (SPA Router & REST Clients)

document.addEventListener('DOMContentLoaded', () => {
  // Authentication Guard
  const token = localStorage.getItem('skyhonix_token');
  const userJson = localStorage.getItem('skyhonix_user');
  
  if (!token || !userJson) {
    window.location.href = 'index.html';
    return;
  }

  const currentUser = JSON.parse(userJson);

  // Expose global variables
  let html5QrcodeScanner = null;
  let activeStudentDmcId = null;

  // Cache selectors
  const sidebarItems = document.querySelectorAll('.sidebar-menu-item');
  const screens = document.querySelectorAll('.screen-section');
  const sidebarSubBadge = document.getElementById('sidebar-sub-badge');
  const headerSchoolName = document.getElementById('header-school-name');
  const headerUserBadge = document.getElementById('header-user-badge');
  const btnLogout = document.getElementById('btn-logout');
  const lockOverlay = document.getElementById('billing-lock-overlay');
  
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toast-text');

  // Set Header Information
  headerSchoolName.innerText = currentUser.schoolName;
  headerUserBadge.innerText = `User: ${currentUser.username} (${currentUser.role})`;

  // Beeper sound generator (Web Audio API)
  function playBeep(type = 'success') {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      if (type === 'success') {
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
        gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.15);
      } else {
        oscillator.type = 'sawtooth';
        oscillator.frequency.setValueAtTime(220, audioCtx.currentTime); // A3
        gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.4);
      }
    } catch (e) {
      console.warn('Audio feedback failed:', e);
    }
  }

  // Toast Notification Helper
  function showToast(message, isError = false) {
    toastText.innerText = message;
    toast.style.borderColor = isError ? 'var(--danger)' : 'var(--primary)';
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 4500);
  }

  // ==========================================
  // REAL-TIME DATA SYNCHRONIZATION SYSTEM
  // ==========================================

  /**
   * Handle sync events emitted from backend
   * Automatically refreshes dependent data when changes occur
   */
  async function handleSyncEvent(syncEvent, eventData) {
    console.log(`[SYNC] Frontend received event: ${syncEvent}`, eventData);

    switch (syncEvent) {
      case 'fees.payment.recorded':
        // Refresh: analytics, dashboard, ledger
        await refreshFeesAnalytics();
        await loadDashboardStats();
        showToast('Fee payment recorded & analytics updated', false);
        break;

      case 'fees.classfee.changed':
        // Refresh: class fees setup, notify about ledger impact
        await loadFeesData();
        showToast(`Class fee updated. Future ledgers will use new fee: ${eventData.newFee}`, false);
        break;

      case 'fees.student-setting.changed':
        // Refresh: ledger entries, analytics
        await refreshFeesAnalytics();
        showToast('Student fee settings updated & analytics refreshed', false);
        break;

      case 'results.marks.updated':
        // Invalidate: results need recalculation
        showToast(`Marks updated for ${eventData.affectedStudents?.length || 1} student(s). Results need recalculation.`, false);
        break;

      case 'results.calculated':
        // Refresh: results view, analytics, dashboard
        await refreshResultsAnalytics();
        await loadDashboardStats();
        showToast(`Results calculated for ${eventData.affectedClasses?.join(', ')} - ${eventData.term}`, false);
        break;

      case 'student.updated':
        // Refresh: student list, related data
        await loadStudentsList();
        showToast('Student record updated & related data synced', false);
        break;

      default:
        console.log(`[SYNC] Unhandled sync event: ${syncEvent}`);
    }
  }

  /**
   * Refresh fees analytics after payment or changes
   */
  async function refreshFeesAnalytics() {
    try {
      const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
      const currentYear = new Date().getFullYear();
      await apiCall(`/fees/analytics?month=${currentMonth}&year=${currentYear}`);

      // Update dashboard if visible
      const dashElement = document.getElementById('stat-pending-dues');
      if (dashElement) {
        await loadDashboardStats();
      }
    } catch (err) {
      console.warn('[SYNC] Failed to refresh fees analytics:', err);
    }
  }

  /**
   * Refresh results analytics after calculation
   */
  async function refreshResultsAnalytics() {
    try {
      const examsTab = document.querySelector('[data-tab="exam-results"]');
      if (examsTab) {
        // Reload results if visible
        const examIdInput = document.getElementById('result-filter-exam');
        if (examIdInput?.value) {
          loadExamsDropdowns();
        }
      }
    } catch (err) {
      console.warn('[SYNC] Failed to refresh results analytics:', err);
    }
  }

  // REST API Client helper (Enhanced with sync event handling)
  async function apiCall(endpoint, method = 'GET', body = null, isFormData = false) {
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    if (!isFormData) {
      headers['Content-Type'] = 'application/json';
    }

    const options = {
      method,
      headers
    };

    if (body) {
      options.body = isFormData ? body : JSON.stringify(body);
    }

    try {
      const response = await fetch(`/api${endpoint}`, options);
      const text = await response.text();
      let result;
      try { result = JSON.parse(text); } catch (e) {
        console.error('API returned non-JSON:', text.substring(0, 200));
        throw new Error('Server returned an invalid response. Please try again.');
      }

      if (response.status === 401 || response.status === 403) {
        if (result.suspended || result.pending) {
          // Trigger billing lock overlay for suspended/pending schools
          lockOverlay.style.display = 'flex';
        } else {
          // Token expired, log out
          localStorage.removeItem('skyhonix_token');
          localStorage.removeItem('skyhonix_user');
          window.location.href = 'index.html';
        }
      }

      if (!response.ok) {
        throw new Error(result.error || 'API Request failed');
      }

      // SYNC: Handle sync events emitted from backend
      if (result.syncEvent) {
        await handleSyncEvent(result.syncEvent, result);
      }

      return result;
    } catch (err) {
      console.error(`API Call failed (${endpoint}):`, err);
      showToast(err.message, true);
      throw err;
    }
  }

  // Check Billing / Lock status
  function checkBillingStatus() {
    apiCall('/billing/status')
      .then(data => {
        const sub = data.school.subscription_status;
        sidebarSubBadge.innerText = sub.toUpperCase();
        sidebarSubBadge.className = 'status-badge';
        
        if (sub === 'active') {
          sidebarSubBadge.classList.add('status-present');
          lockOverlay.style.display = 'none';
        } else if (sub === 'trial') {
          sidebarSubBadge.classList.add('status-partial');
          sidebarSubBadge.innerText = `TRIAL DUE: ${data.school.next_due_date}`;
          lockOverlay.style.display = 'none';
        } else {
          sidebarSubBadge.classList.add('status-absent');
          lockOverlay.style.display = 'flex';
          const lockReason = document.getElementById('lock-reason-text');
          if (lockReason) {
            if (sub === 'pending') {
              lockReason.innerHTML = 'Your school registration is <strong>pending admin approval</strong>. Please upload a payment receipt below, or wait for admin activation.';
            } else {
              lockReason.innerHTML = 'Your school subscription is <strong>suspended or overdue</strong>. Billed at <strong>1500 PKR monthly</strong>. Please upload your payment transfer receipt to restore full system access.';
            }
          }
          const codeEl = document.getElementById('lock-school-code-display');
          if (codeEl && data.school.school_code) {
            codeEl.innerHTML = `Your Unique School Code: <strong>${data.school.school_code}</strong>`;
          }
        }
      })
      .catch(() => {
        sidebarSubBadge.innerText = 'ERROR';
        sidebarSubBadge.className = 'status-badge status-absent';
      });
  }

  // Sidebar navigation toggles
  sidebarItems.forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      
      const targetScreen = item.getAttribute('data-screen');
      
      // Stop scanner if navigating away from attendance screen
      if (targetScreen !== 'attendance' && html5QrcodeScanner) {
        stopQrScanner();
      }

      // Toggle active link
      sidebarItems.forEach(i => i.classList.remove('active'));
      item.classList.add('active');

      // Toggle visible screen
      screens.forEach(screen => {
        if (screen.id === `screen-${targetScreen}`) {
          screen.style.display = 'block';
        } else {
          screen.style.display = 'none';
        }
      });

      // Load screen specific content
      loadScreenData(targetScreen);

      // Close mobile sidebar on navigation
      if (window.innerWidth <= 992) {
        closeSidebar();
      }
    });
  });

  // Mobile sidebar toggle
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');

  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('active');
  }

  function openSidebar() {
    sidebar.classList.add('open');
    sidebarOverlay.classList.add('active');
  }

  btnSidebarToggle.addEventListener('click', () => {
    if (sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }

  // Logout Trigger
  btnLogout.addEventListener('click', () => {
    localStorage.removeItem('skyhonix_token');
    localStorage.removeItem('skyhonix_user');
    window.location.href = 'index.html';
  });

  document.getElementById('btn-lock-logout').addEventListener('click', () => {
    localStorage.removeItem('skyhonix_token');
    localStorage.removeItem('skyhonix_user');
    window.location.href = 'index.html';
  });

  // Screen Router Initial Loaders
  function loadScreenData(screenName) {
    if (screenName === 'dashboard') {
      loadDashboardStats();
    } else if (screenName === 'students') {
      loadClassesList();
      loadStudentsList();
    } else if (screenName === 'attendance') {
      loadAttendanceFilters();
    } else if (screenName === 'fees') {
      loadFeesData();
    } else if (screenName === 'exams') {
      loadExamsData();
    } else if (screenName === 'settings') {
      loadSettingsData();
    } else if (screenName === 'subscription') {
      loadBillingData();
    } else if (screenName === 'admin-settings') {
      const adminScreen = document.getElementById('screen-admin-settings');
      if (adminScreen) {
        adminScreen.querySelectorAll('.fee-option-panel').forEach(p => p.style.display = 'none');
        adminScreen.querySelectorAll(':scope > .card, :scope > .grid-3').forEach(c => c.style.display = '');
      }
    } else if (screenName === 'student-profile') {
      loadStudentProfileFilters();
      loadStudentProfileList();
    }
  }

  // Tabs layout navigation inside screens
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      // Scope tabs to the closest panel container (exam-option-panel or fee-option-panel) or screen-section
      const container = btn.closest('.exam-option-panel') || btn.closest('.fee-option-panel') || btn.closest('.screen-section');
      
      // Toggle button active
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Toggle content panel
      const targetTab = btn.getAttribute('data-tab');
      container.querySelectorAll('.tab-content').forEach(content => {
        if (content.id === `tab-${targetTab}`) {
          content.style.display = 'block';
        } else {
          content.style.display = 'none';
        }
      });
    });
  });

  // ==========================================
  // MODULE: DASHBOARD
  // ==========================================
  async function loadDashboardStats() {
    try {
      const totalStudents = await apiCall('/students');
      document.getElementById('stat-total-students').innerText = totalStudents.length;

      const dateStr = new Date().toISOString().split('T')[0];
      const attStats = await apiCall(`/attendance/analytics?date=${dateStr}`);
      let presentCount = 0;
      let totalAttLogs = 0;
      attStats.stats.forEach(s => {
        if (s.status === 'Present') presentCount = s.count;
        totalAttLogs += s.count;
      });

      const rate = totalAttLogs > 0 ? Math.round((presentCount / totalAttLogs) * 100) : 0;
      document.getElementById('stat-attendance-rate').innerText = totalAttLogs > 0 ? `${rate}%` : '0%';

      // Fees Collections
      const ledger = await apiCall('/fees/ledger');
      let totalPending = 0;
      let totalCollected = 0;
      const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });
      const currentYear = new Date().getFullYear();

      ledger.forEach(row => {
        totalPending += (row.total_payable - row.paid_amount);
        if (row.month === currentMonth && row.year === currentYear) {
          totalCollected += row.paid_amount;
        }
      });

      document.getElementById('stat-month-fees').innerText = `${totalCollected.toLocaleString()} PKR`;
      document.getElementById('stat-pending-dues').innerText = `${totalPending.toLocaleString()} PKR`;

      // Load School Details
      const settings = await apiCall('/settings');
      document.getElementById('dash-school-title').innerText = settings.school_name;
      document.getElementById('dash-school-phone').innerText = `Phone: ${settings.phone || 'N/A'}`;
      document.getElementById('dash-school-reg').innerText = `Reg No: ${settings.registration_number || 'N/A'}`;
      document.getElementById('dash-school-id').innerText = `School ID: ${currentUser.schoolId || 'N/A'}`;
      if (settings.logo_path) {
        document.getElementById('dash-school-logo').src = '/' + settings.logo_path;
      }

    } catch (e) {
      console.error(e);
    }
  }

  // Dashboard shortcuts
  document.getElementById('dash-btn-students').addEventListener('click', () => {
    document.querySelector('[data-screen="students"]').click();
    document.getElementById('btn-add-student').click();
  });
  document.getElementById('dash-btn-scan').addEventListener('click', () => {
    document.querySelector('[data-screen="attendance"]').click();
    document.querySelector('[data-tab="att-scan"]').click();
    document.getElementById('btn-start-scanner').click();
  });
  document.getElementById('dash-btn-fees').addEventListener('click', () => {
    document.querySelector('[data-screen="fees"]').click();
    document.querySelector('[data-tab="fee-generator"]').click();
  });


  // ==========================================
  // MODULE: STUDENTS
  // ==========================================
  let cachedClasses = [];

  async function loadClassesList() {
    try {
      const classes = await apiCall('/students/classes');
      cachedClasses = classes;
      
      const filterClass = document.getElementById('student-filter-class');
      const attClassSelect = document.getElementById('att-class-select');
      const attHistoryClass = document.getElementById('att-history-class');
      const ledgerFilterClass = document.getElementById('ledger-filter-class');
      const marksSelectClass = document.getElementById('marks-select-class');
      const calcClassSelect = document.getElementById('calc-class-select');
      const historyFilterClass = document.getElementById('history-filter-class');
      const studentFeeClass = document.getElementById('student-fee-class');
      const reminderFilterClass = document.getElementById('reminder-filter-class');
      const datesheetClassSelect = document.getElementById('datesheet-class-select');
      const rollnoClassSelect = document.getElementById('rollno-class-select');
      const rollnoGenClass = document.getElementById('rollno-gen-class');

      const selects = [
        filterClass, attClassSelect, attHistoryClass, ledgerFilterClass,
        marksSelectClass, calcClassSelect,
        historyFilterClass, studentFeeClass, reminderFilterClass,
        datesheetClassSelect, rollnoClassSelect, rollnoGenClass
      ];

      selects.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        const isAllClasses = ['student-filter-class', 'history-filter-class', 'student-fee-class', 'datesheet-class-select', 'rollno-class-select', 'rollno-gen-class'].includes(sel.id);
        const isSelectPlaceholder = ['reminder-filter-class'].includes(sel.id);
        
        if (isAllClasses) {
          sel.innerHTML = '<option value="All Classes">All Classes</option>';
        } else if (isSelectPlaceholder) {
          sel.innerHTML = '<option value="">-- Select Class --</option>';
        } else {
          sel.innerHTML = '';
        }
        
        classes.forEach(cls => {
          sel.innerHTML += `<option value="${cls}">${cls}</option>`;
        });
        if (currentVal) sel.value = currentVal;
      });

    } catch (e) {}
  }

  async function loadStudentsList() {
    const cls = document.getElementById('student-filter-class').value;
    const sec = document.getElementById('student-filter-section').value;
    const search = document.getElementById('student-search').value.trim();

    let endpoint = '/students?';
    if (cls) endpoint += `class_name=${encodeURIComponent(cls)}&`;
    if (sec) endpoint += `section_name=${encodeURIComponent(sec)}&`;
    if (search) endpoint += `search=${encodeURIComponent(search)}&`;

    try {
      const students = await apiCall(endpoint);
      const tbody = document.querySelector('#table-students tbody');
      tbody.innerHTML = '';

      if (students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No students found</td></tr>';
        return;
      }

      students.forEach(s => {
        const hasSibling = s.family_head_id ? `<span class="sib-badge">Sibling</span>` : (s.family_head_id === null ? '' : '');
        const roleText = s.family_head_id ? `Linked to Head` : 'Family Head';
        
        let waiverText = 'Standard';
        if (s.is_free) waiverText = '<span style="color: var(--accent);">Free Waiver</span>';
        else if (s.discount_amount > 0) waiverText = `-${s.discount_amount} PKR`;
        else if (s.discount_percent > 0) waiverText = `-${s.discount_percent}%`;

        tbody.innerHTML += `
          <tr>
            <td>${s.student_id}</td>
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td>
              <div style="display:flex; align-items:center; gap: 10px;">
                <img src="/${s.photo || 'school_assets/school_logo.png'}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;">
                <strong>${s.name}</strong>
              </div>
            </td>
            <td>${s.father_name || '-'}</td>
            <td>${s.class_name} - ${s.section_name || 'N/A'}</td>
            <td>${waiverText}</td>
            <td>${hasSibling ? `${hasSibling} <span style="font-size:0.75rem; color:var(--text-muted);">${roleText}</span>` : 'Individual'}</td>
            <td>
              <div style="display:flex; gap:8px;">
                <button class="btn btn-outline btn-sm btn-edit-student" data-id="${s.id}">Edit</button>
                <button class="btn btn-primary btn-sm btn-qr-student" data-id="${s.id}" data-name="${s.name}" data-roll="${s.roll_no}" data-class="${s.class_name}" data-code="${s.student_id}">Card</button>
                <button class="btn btn-outline btn-sm btn-sib-student" data-id="${s.id}" data-name="${s.name}" data-head="${s.family_head_id || ''}">Siblings</button>
                <button class="btn btn-danger btn-sm btn-archive-student" data-id="${s.id}">&times;</button>
              </div>
            </td>
          </tr>
        `;
      });

      // Bind events
      attachStudentTableEvents();

    } catch (e) {}
  }

  // Filter Listeners
  document.getElementById('student-filter-class').addEventListener('change', loadStudentsList);
  document.getElementById('student-filter-section').addEventListener('change', loadStudentsList);
  document.getElementById('student-search').addEventListener('input', loadStudentsList);

  // Student Modals and forms setup
  const modalStudent = document.getElementById('modal-student');
  const btnAddStudent = document.getElementById('btn-add-student');
  const btnCloseStudentModal = document.getElementById('btn-close-student-modal');
  const formStudent = document.getElementById('form-student');

  btnAddStudent.addEventListener('click', () => {
    formStudent.reset();
    document.getElementById('student-edit-id').value = '';
    document.getElementById('modal-student-title').innerText = 'Add Student Profile';
    document.getElementById('stud-id').value = '';
    modalStudent.classList.add('open');
  });

  btnCloseStudentModal.addEventListener('click', () => modalStudent.classList.remove('open'));

  // Compress image to under 50KB using Canvas
  function compressImage(file, maxKB) {
    return new Promise((resolve, reject) => {
      maxKB = maxKB || 50;
      const reader = new FileReader();
      reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
          let width = img.width;
          let height = img.height;
          // Scale down if larger than 800px on any side
          const maxDim = 800;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
            else { width = Math.round(width * maxDim / height); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          // Start with high quality, reduce if still too large
          let quality = 0.9;
          let blob;
          const tryCompress = () => {
            canvas.toBlob(function(b) {
              blob = b;
              if (blob.size > maxKB * 1024 && quality > 0.1) {
                quality -= 0.1;
                tryCompress();
              } else {
                resolve(blob);
              }
            }, 'image/jpeg', quality);
          };
          tryCompress();
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  // Save student (Form POST/PUT)
  formStudent.addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('student-edit-id').value;
    const isEdit = !!editId;

    const formData = new FormData();
    formData.append('student_id', document.getElementById('stud-id').value);
    formData.append('admission_no', document.getElementById('stud-admno').value);
    formData.append('roll_no', document.getElementById('stud-roll').value);
    formData.append('name', document.getElementById('stud-name').value);
    formData.append('father_name', document.getElementById('stud-father').value);
    formData.append('class_name', document.getElementById('stud-class').value);
    formData.append('section_name', document.getElementById('stud-section').value);
    formData.append('phone', document.getElementById('stud-phone').value);
    formData.append('dob', document.getElementById('stud-dob').value);
    formData.append('dob_words', document.getElementById('stud-dobwords').value);
    formData.append('slc_no', document.getElementById('stud-slc').value);
    formData.append('national_id', document.getElementById('stud-nationalid').value);
    formData.append('religion', document.getElementById('stud-religion').value);
    formData.append('gender', document.getElementById('stud-gender').value);
    formData.append('status', document.getElementById('stud-status').value);
    formData.append('discount_amount', document.getElementById('stud-disc-amount').value || 0);
    formData.append('discount_percent', document.getElementById('stud-disc-percent').value || 0);
    formData.append('transport_fee', document.getElementById('stud-transport').value || 0);
    formData.append('is_free', document.getElementById('stud-isfree').checked ? 1 : 0);

    const fileInput = document.getElementById('stud-photo-file');
    if (fileInput.files[0]) {
      try {
        const compressed = await compressImage(fileInput.files[0], 50);
        formData.append('photo', compressed, 'photo.jpg');
      } catch (e) {
        formData.append('photo', fileInput.files[0]);
      }
    }

    try {
      const endpoint = isEdit ? `/students/${editId}` : '/students';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await apiCall(endpoint, method, formData, true);
      showToast(res.message);
      modalStudent.classList.remove('open');
      loadStudentsList();
      loadClassesList();
    } catch (err) {}
  });

  // Table events linking
  function attachStudentTableEvents() {
    // Edit Profile Clicked
    document.querySelectorAll('.btn-edit-student').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          const data = await apiCall(`/students/${id}`);
          const s = data.student;

          document.getElementById('student-edit-id').value = s.id;
          document.getElementById('modal-student-title').innerText = 'Edit Student Profile';
          document.getElementById('stud-id').value = s.student_id;
          document.getElementById('stud-admno').value = s.admission_no || '';
          document.getElementById('stud-roll').value = s.roll_no || '';
          document.getElementById('stud-name').value = s.name;
          document.getElementById('stud-father').value = s.father_name || '';
          document.getElementById('stud-class').value = s.class_name;
          document.getElementById('stud-section').value = s.section_name || '';
          document.getElementById('stud-phone').value = s.phone || '';
          document.getElementById('stud-dob').value = s.dob || '';
          document.getElementById('stud-dobwords').value = s.dob_words || '';
          document.getElementById('stud-slc').value = s.slc_no || '';
          document.getElementById('stud-nationalid').value = s.national_id || '';
          document.getElementById('stud-religion').value = s.religion || 'Islam';
          document.getElementById('stud-gender').value = s.gender || 'Male';
          document.getElementById('stud-status').value = s.status || 'Active';
          document.getElementById('stud-disc-amount').value = s.discount_amount || 0;
          document.getElementById('stud-disc-percent').value = s.discount_percent || 0;
          document.getElementById('stud-transport').value = s.transport_fee || 0;
          document.getElementById('stud-isfree').checked = s.is_free === 1;

          modalStudent.classList.add('open');
        } catch (e) {}
      });
    });

    // Archive Clicked
    document.querySelectorAll('.btn-archive-student').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        if (confirm('Are you sure you want to mark this student as Left (Inactive)?')) {
          try {
            const res = await apiCall(`/students/${id}/archive`, 'POST');
            showToast(res.message);
            loadStudentsList();
          } catch (e) {}
        }
      });
    });

    // QR Print Clicked
    const modalQr = document.getElementById('modal-print-qr');
    const qrPlaceholder = document.getElementById('qr-code-placeholder');
    document.querySelectorAll('.btn-qr-student').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.getAttribute('data-name');
        const roll = btn.getAttribute('data-roll');
        const className = btn.getAttribute('data-class');
        const code = btn.getAttribute('data-code');

        document.getElementById('qr-card-school').innerText = currentUser.schoolName;
        document.getElementById('qr-card-name').innerText = name;
        document.getElementById('qr-card-roll').innerText = `Roll No: ${roll || 'N/A'} | Class: ${className}`;
        document.getElementById('qr-card-id').innerText = `Student ID: ${code}`;

        // Generate QR code using QRServer API
        qrPlaceholder.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(code)}" alt="Student Code QR" style="width:130px; height:130px;">`;
        
        modalQr.classList.add('open');
      });
    });

    document.getElementById('btn-close-qr-modal').addEventListener('click', () => {
      modalQr.classList.remove('open');
    });

    document.getElementById('btn-print-qr-execute').addEventListener('click', () => {
      const printContents = document.getElementById('print-card-content').innerHTML;
      const originalContents = document.body.innerHTML;

      document.body.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:center; height:100vh; background:white; color:black;">
          <div style="width:300px; padding:20px; border:2px solid black; border-radius:10px; text-align:center;">
            ${printContents}
          </div>
        </div>
      `;
      window.print();
      // Reload page to restore UI state after printing
      window.location.reload();
    });

    // Sibling Links modal triggers
    const modalSibling = document.getElementById('modal-sibling');
    const sibHeadSelect = document.getElementById('sib-head-select');
    document.querySelectorAll('.btn-sib-student').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const currentHead = btn.getAttribute('data-head');

        document.getElementById('sib-student-id').value = id;
        document.getElementById('sib-target-student').innerText = name;
        document.getElementById('sib-target-status').innerText = currentHead ? `Sibling (linked to ID: ${currentHead})` : 'Individual Account (unlinked)';
        
        try {
          // Fetch prospective sibling heads (excluding current student)
          const candidates = await apiCall(`/students/sibling-candidates/all?excludeId=${id}`);
          sibHeadSelect.innerHTML = '<option value="">-- Choose Head Student --</option>';
          candidates.forEach(c => {
            sibHeadSelect.innerHTML += `<option value="${c.id}">${c.name} (Roll: ${c.roll_no}, Class: ${c.class_name}, Father: ${c.father_name})</option>`;
          });

          if (currentHead) sibHeadSelect.value = currentHead;
          modalSibling.classList.add('open');
        } catch (e) {}
      });
    });

    document.getElementById('btn-close-sib-modal').addEventListener('click', () => {
      modalSibling.classList.remove('open');
    });

    // Submit Sibling Link Form
    document.getElementById('form-link-sibling').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('sib-student-id').value;
      const familyHeadId = sibHeadSelect.value;

      try {
        // Fetch current details, modify family head mapping
        const data = await apiCall(`/students/${id}`);
        const s = data.student;
        s.family_head_id = familyHeadId;

        await apiCall(`/students/${id}`, 'PUT', s);
        showToast('Sibling association linked successfully!');
        modalSibling.classList.remove('open');
        loadStudentsList();
      } catch (err) {}
    });

    // Unlink Sibling Trigger
    document.getElementById('btn-unlink-sibling').addEventListener('click', async () => {
      const id = document.getElementById('sib-student-id').value;
      try {
        const data = await apiCall(`/students/${id}`);
        const s = data.student;
        s.family_head_id = null;

        await apiCall(`/students/${id}`, 'PUT', s);
        showToast('Student unlinked from siblings ledger.');
        modalSibling.classList.remove('open');
        loadStudentsList();
      } catch (err) {}
    });
  }


  // ==========================================
  // MODULE: STUDENT PROFILE
  // ==========================================

  async function loadStudentProfileFilters() {
    try {
      const classes = await apiCall('/students/classes');
      const classSelect = document.getElementById('sp-class-select');
      if (classSelect) {
        classSelect.innerHTML = '<option value="">-- All Classes --</option>';
        classes.forEach(c => {
          const name = typeof c === 'object' ? c.class_name : c;
          classSelect.innerHTML += `<option value="${name}">${name}</option>`;
        });
      }
    } catch (e) {}
  }

  document.getElementById('sp-class-select').addEventListener('change', async function() {
    const className = this.value;
    const sectionSelect = document.getElementById('sp-section-select');
    const studentSelect = document.getElementById('sp-student-select');
    sectionSelect.innerHTML = '<option value="">-- All Sections --</option>';
    studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
    document.getElementById('sp-profile-container').style.display = 'none';
    if (!className) return;
    try {
      const sections = await apiCall(`/students/sections/${encodeURIComponent(className)}`);
      sections.forEach(s => { sectionSelect.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`; });
      loadStudentProfileList();
    } catch (e) {}
  });

  document.getElementById('sp-section-select').addEventListener('change', () => {
    loadStudentProfileList();
    document.getElementById('sp-profile-container').style.display = 'none';
  });

  async function loadStudentProfileList() {
    const className = document.getElementById('sp-class-select').value;
    const sectionName = document.getElementById('sp-section-select').value;
    const studentSelect = document.getElementById('sp-student-select');
    studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
    try {
      let url = '/students?';
      if (className) url += `class_name=${encodeURIComponent(className)}&`;
      if (sectionName) url += `section_name=${encodeURIComponent(sectionName)}&`;
      const students = await apiCall(url);
      students.forEach(s => {
        studentSelect.innerHTML += `<option value="${s.id}">${s.roll_no || '-'} - ${s.name}</option>`;
      });
    } catch (e) {}
  }

  document.getElementById('sp-student-select').addEventListener('change', async function() {
    const studentId = this.value;
    if (!studentId) {
      document.getElementById('sp-profile-container').style.display = 'none';
      return;
    }
    await loadStudentProfile(studentId);
  });

  async function loadStudentProfile(studentId) {
    const container = document.getElementById('sp-profile-container');
    container.style.display = 'block';

    // Show loading state
    document.getElementById('sp-student-name').innerText = 'Loading...';

    try {
      const data = await apiCall(`/students/${studentId}/profile`);
      const s = data.student;
      const stats = data.stats;

      // Header
      document.getElementById('sp-avatar').innerText = (s.name || 'S')[0].toUpperCase();
      document.getElementById('sp-student-name').innerText = s.name || 'Unknown';
      document.getElementById('sp-class-info').innerText = `Class: ${s.class_name || '-'}${s.section_name ? ' - ' + s.section_name : ''}`;
      document.getElementById('sp-roll-info').innerText = `Roll No: ${s.roll_no || '-'}`;
      document.getElementById('sp-father-info').innerText = `Father: ${s.father_name || '-'}`;
      document.getElementById('sp-status-badge').innerText = s.status || 'Active';
      document.getElementById('sp-attendance-rate').innerText = `${stats.attendanceRate}%`;

      // Overview - Personal Info
      document.getElementById('sp-info-name').innerText = s.name || '-';
      document.getElementById('sp-info-father').innerText = s.father_name || '-';
      document.getElementById('sp-info-dob').innerText = s.dob || '-';
      document.getElementById('sp-info-gender').innerText = s.gender || '-';
      document.getElementById('sp-info-phone').innerText = s.phone || '-';
      document.getElementById('sp-info-address').innerText = s.address || '-';

      // Overview - Stats
      document.getElementById('sp-total-marks').innerText = stats.totalMarksObtained;
      document.getElementById('sp-avg-marks').innerText = `${stats.avgPercentage}%`;
      document.getElementById('sp-pending-dues').innerText = stats.totalDue.toLocaleString();
      document.getElementById('sp-total-paid').innerText = stats.totalPaid.toLocaleString();

      // Fee Ledger
      const feeLedgerBody = document.getElementById('sp-fee-ledger-body');
      if (data.feeLedger.length === 0) {
        feeLedgerBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No fee records found.</td></tr>';
      } else {
        feeLedgerBody.innerHTML = data.feeLedger.map(f => {
          const due = (f.total_payable || 0) - (f.paid_amount || 0);
          const status = due <= 0 ? '<span class="badge badge-green">Paid</span>' : due < f.total_payable ? '<span class="badge badge-yellow">Partial</span>' : '<span class="badge badge-red">Unpaid</span>';
          return `<tr>
            <td>${f.month || '-'}</td>
            <td>${f.year || '-'}</td>
            <td>${(f.total_payable || 0).toLocaleString()}</td>
            <td>${(f.paid_amount || 0).toLocaleString()}</td>
            <td>${due > 0 ? due.toLocaleString() : '0'}</td>
            <td>${status}</td>
          </tr>`;
        }).join('');
      }

      // Payments
      const paymentsBody = document.getElementById('sp-payments-body');
      if (data.payments.length === 0) {
        paymentsBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No payments found.</td></tr>';
      } else {
        paymentsBody.innerHTML = data.payments.map(p => `<tr>
          <td>${p.payment_date || '-'}</td>
          <td><strong>${(p.amount_paid || 0).toLocaleString()} PKR</strong></td>
          <td>${p.payment_method || '-'}</td>
          <td>${p.receipt_number || '-'}</td>
          <td>${p.notes || '-'}</td>
        </tr>`).join('');
      }

      // Marks
      const marksBody = document.getElementById('sp-marks-body');
      if (data.marks.length === 0) {
        marksBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No marks found.</td></tr>';
      } else {
        marksBody.innerHTML = data.marks.map(m => {
          const maxM = m.max_marks || 100;
          const pct = maxM > 0 ? ((m.marks / maxM) * 100).toFixed(1) : 0;
          return `<tr>
            <td>${m.exam_name || '-'}</td>
            <td>${m.term || '-'}</td>
            <td>${m.subject || '-'}</td>
            <td><strong>${m.marks !== null ? m.marks : '-'}</strong></td>
            <td>${maxM}</td>
            <td>${pct}%</td>
          </tr>`;
        }).join('');
      }

      // Results
      const resultsBody = document.getElementById('sp-results-body');
      if (data.results.length === 0) {
        resultsBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No results found.</td></tr>';
      } else {
        resultsBody.innerHTML = data.results.map(r => `<tr>
          <td>${r.exam_name || '-'}</td>
          <td>${r.total_marks || '-'}</td>
          <td><strong>${r.obtained_marks || '-'}</strong></td>
          <td>${r.percentage ? r.percentage + '%' : '-'}</td>
          <td><span class="badge badge-blue">${r.grade || '-'}</span></td>
          <td>${r.position || '-'}</td>
        </tr>`).join('');
      }

      // Attendance
      document.getElementById('sp-att-present').innerText = stats.presentDays;
      document.getElementById('sp-att-absent').innerText = stats.absentDays;

      const attBody = document.getElementById('sp-attendance-body');
      if (data.attendance.length === 0) {
        attBody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted);">No attendance records found.</td></tr>';
      } else {
        attBody.innerHTML = data.attendance.map(a => {
          const isPresent = a.status === 'present' || a.status === 'Present';
          return `<tr>
            <td>${a.date || '-'}</td>
            <td><span class="badge ${isPresent ? 'badge-green' : 'badge-red'}">${a.status || '-'}</span></td>
            <td>${a.created_at || '-'}</td>
          </tr>`;
        }).join('');
      }

    } catch (err) {
      container.innerHTML = `<div class="card" style="padding: 40px; text-align: center; color: var(--danger);">Error loading profile: ${err.message}</div>`;
    }
  }


  // ==========================================
  // MODULE: ATTENDANCE
  // ==========================================
  function loadAttendanceFilters() {
    loadClassesList();
    document.getElementById('att-date-input').value = new Date().toISOString().split('T')[0];
    document.getElementById('att-history-month').value = new Date().toISOString().slice(0, 7);
  }

  // Load section selection dynamically
  document.getElementById('att-class-select').addEventListener('change', async (e) => {
    const cls = e.target.value;
    const secSelect = document.getElementById('att-sec-select');
    secSelect.innerHTML = '<option value="">All Sections</option>';
    if (!cls) return;

    try {
      const sections = await apiCall(`/students/sections/${cls}`);
      sections.forEach(s => {
        secSelect.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`;
      });
      secSelect.innerHTML += '<option value="No Section">No Section</option>';
    } catch (err) {}
  });

  // Load Grid Students
  const tableAttGrid = document.getElementById('table-attendance-grid');
  document.getElementById('btn-load-att-grid').addEventListener('click', async () => {
    const cls = document.getElementById('att-class-select').value;
    const sec = document.getElementById('att-sec-select').value;
    const date = document.getElementById('att-date-input').value;

    if (!cls || !date) {
      showToast('Class and Date are required', true);
      return;
    }

    try {
      let url = `/attendance/students?class_name=${encodeURIComponent(cls)}&date=${date}`;
      if (sec) url += `&section_name=${encodeURIComponent(sec)}`;

      const students = await apiCall(url);
      const tbody = tableAttGrid.querySelector('tbody');
      tbody.innerHTML = '';

      if (students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No active students found in this class</td></tr>';
        document.getElementById('att-grid-actions').style.display = 'none';
        return;
      }

      students.forEach(s => {
        const statuses = ['Present', 'Absent', 'Late', 'Unmarked'];
        let options = '';
        statuses.forEach(st => {
          options += `<option value="${st}" ${s.status === st ? 'selected' : ''}>${st}</option>`;
        });

        tbody.innerHTML += `
          <tr data-student-id="${s.id}">
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td>
              <div style="display:flex; align-items:center; gap:10px;">
                <img src="/${s.photo || 'school_assets/school_logo.png'}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;">
                <span>${s.name}</span>
              </div>
            </td>
            <td>${s.class_name} - ${s.section_name || 'N/A'}</td>
            <td>
              <select class="form-control att-row-status" style="width:auto; padding:6px 12px;">
                ${options}
              </select>
            </td>
            <td>
              <input type="text" class="form-control att-row-time" style="width:100px; padding:6px 12px; text-align:center;" value="${s.time || ''}" placeholder="hh:mm AM">
            </td>
          </tr>
        `;
      });

      document.getElementById('att-grid-actions').style.display = 'block';

    } catch (e) {}
  });

  // Save Attendance from grid list
  document.getElementById('btn-save-attendance').addEventListener('click', async () => {
    const date = document.getElementById('att-date-input').value;
    const rows = document.querySelectorAll('#table-attendance-grid tbody tr');
    const list = [];

    rows.forEach(row => {
      const student_id = row.getAttribute('data-student-id');
      const status = row.querySelector('.att-row-status').value;
      const time = row.querySelector('.att-row-time').value;

      if (status !== 'Unmarked') {
        const cls = document.getElementById('att-class-select').value;
        const sec = document.getElementById('att-sec-select').value;
        list.push({
          student_id,
          class_name: cls,
          section_name: sec === 'No Section' ? '' : sec,
          status,
          time
        });
      }
    });

    try {
      const res = await apiCall('/attendance/save', 'POST', { date, attendanceList: list });
      showToast(res.message);
    } catch (err) {}
  });

  // Webcam QR Scanner logic
  const btnStartScanner = document.getElementById('btn-start-scanner');
  const btnStopScanner = document.getElementById('btn-stop-scanner');
  const scanHistoryTable = document.querySelector('#table-scan-history tbody');
  const scanFeedback = document.getElementById('scan-feedback-container');

  btnStartScanner.addEventListener('click', () => {
    if (html5QrcodeScanner) return;

    scanFeedback.style.display = 'none';
    html5QrcodeScanner = new Html5Qrcode('reader');
    
    html5QrcodeScanner.start(
      { facingMode: 'user' }, // use front/self camera
      {
        fps: 10,
        qrbox: { width: 250, height: 250 }
      },
      async (decodedText) => {
        // Scanned QR code
        try {
          const dateStr = new Date().toISOString().split('T')[0];
          const result = await apiCall('/attendance/scan', 'POST', { scanValue: decodedText, date: dateStr });
          
          playBeep('success');
          showToast(result.message);

          // Update success display
          document.getElementById('scan-name').innerText = result.student.name;
          document.getElementById('scan-roll-class').innerText = `Roll No: ${result.student.roll_no || '-'} | Class: ${result.student.class_name}`;
          document.getElementById('scan-time').innerText = `Checked in: ${result.student.time}`;
          document.getElementById('scan-photo').src = '/' + (result.student.photo || 'school_assets/school_logo.png');
          scanFeedback.style.display = 'block';

          // Append to log table
          const existingRows = scanHistoryTable.innerHTML;
          if (existingRows.includes('Awaiting QR card scan')) {
            scanHistoryTable.innerHTML = '';
          }
          scanHistoryTable.innerHTML = `
            <tr>
              <td><strong>${result.student.roll_no || '-'}</strong></td>
              <td>${result.student.name}</td>
              <td>${result.student.class_name}</td>
              <td><span style="color:var(--accent); font-weight:700;">${result.student.time}</span></td>
            </tr>
          ` + scanHistoryTable.innerHTML;

        } catch (err) {
          playBeep('fail');
          showToast(`Invalid scan check-in: ${err.message}`, true);
        }
      },
      (errorMessage) => {
        // Verbose scanner error, ignore
      }
    ).catch(err => {
      showToast(`Camera activation error: ${err}`, true);
    });
  });

  function stopQrScanner() {
    if (html5QrcodeScanner) {
      html5QrcodeScanner.stop().then(() => {
        html5QrcodeScanner = null;
        document.getElementById('reader').innerHTML = '';
      }).catch(err => console.error(err));
    }
  }

  btnStopScanner.addEventListener('click', stopQrScanner);

  // Attendance history logs
  document.getElementById('btn-load-att-history').addEventListener('click', async () => {
    const class_name = document.getElementById('att-history-class').value;
    const month_year = document.getElementById('att-history-month').value;

    if (!class_name || !month_year) {
      showToast('Class and Month are required', true);
      return;
    }

    try {
      const logs = await apiCall(`/attendance/history?class_name=${encodeURIComponent(class_name)}&month_year=${month_year}`);
      const tbody = document.querySelector('#table-attendance-history tbody');
      tbody.innerHTML = '';

      if (logs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">No logs found for this period</td></tr>';
        return;
      }

      // Group logs by student
      const studentLogs = {};
      logs.forEach(log => {
        if (!studentLogs[log.student_id]) {
          studentLogs[log.student_id] = {
            name: log.name,
            roll_no: log.roll_no,
            records: []
          };
        }
        studentLogs[log.student_id].records.push({ date: log.date, status: log.status });
      });

      Object.keys(studentLogs).forEach(id => {
        const student = studentLogs[id];
        let pills = '';
        
        // Render up to 31 day summary details
        student.records.sort((a,b) => new Date(a.date) - new Date(b.date));
        student.records.forEach(r => {
          const day = r.date.split('-')[2];
          const badgeClass = r.status === 'Present' ? 'status-present' : (r.status === 'Absent' ? 'status-unpaid' : 'status-partial');
          pills += `<span class="status-badge ${badgeClass}" style="margin:2px; font-size:0.7rem;" title="${r.date}">${day}: ${r.status.substring(0, 1)}</span>`;
        });

        tbody.innerHTML += `
          <tr>
            <td><strong>${student.roll_no || '-'}</strong></td>
            <td><strong>${student.name}</strong></td>
            <td><div style="display:flex; flex-wrap:wrap;">${pills}</div></td>
          </tr>
        `;
      });

    } catch (e) {}
  });


  // ==========================================
  // MODULE: FEES & LEDGER
  // ==========================================
  let collectionChartInstance = null;

  function loadFeesData() {
    resetFeePanels();
    loadClassesList();
    loadClassFeeRules();
  }

  // Helper to reset and show dashboard
  function resetFeePanels() {
    const dash = document.getElementById('fees-dashboard-view');
    if (dash) dash.style.display = 'block';
    document.querySelectorAll('.fee-option-panel').forEach(panel => {
      panel.style.display = 'none';
    });
  }

  // Dashboard card clicks to show target panel
  document.querySelectorAll('.fees-dash-card').forEach(card => {
    card.addEventListener('click', () => {
      const targetOpt = card.getAttribute('data-opt');
      const dash = document.getElementById('fees-dashboard-view');
      if (dash) dash.style.display = 'none';
      document.querySelectorAll('.fee-option-panel').forEach(p => p.style.display = 'none');
      
      const targetPanel = document.getElementById(`fee-panel-${targetOpt}`);
      if (targetPanel) {
        targetPanel.style.display = 'block';
        loadFeePanelData(targetOpt);
      }
    });
  });

  // Back button click in option panels
  document.querySelectorAll('.btn-back-fee-dash').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      resetFeePanels();
    });
  });

  // Dynamic dropdown loaders & change listeners
  const histFilterClass = document.getElementById('history-filter-class');
  if (histFilterClass) {
    histFilterClass.addEventListener('change', () => {
      updateSectionDropdown('history-filter-class', 'history-filter-section', true);
    });
  }
  const studFeeClass = document.getElementById('student-fee-class');
  if (studFeeClass) {
    studFeeClass.addEventListener('change', () => {
      updateSectionDropdown('student-fee-class', 'student-fee-section', true);
    });
  }
  const remindFilterClass = document.getElementById('reminder-filter-class');
  if (remindFilterClass) {
    remindFilterClass.addEventListener('change', () => {
      updateSectionDropdown('reminder-filter-class', 'reminder-filter-section', false);
    });
  }
  const marksFilterClass = document.getElementById('marks-select-class');
  if (marksFilterClass) {
    marksFilterClass.addEventListener('change', () => {
      updateSectionDropdown('marks-select-class', 'marks-select-sec', true);
    });
  }

  // Section dropdown helper
  async function updateSectionDropdown(classSelectId, sectionSelectId, includeAllOption = true) {
    const clsEl = document.getElementById(classSelectId);
    const secSelect = document.getElementById(sectionSelectId);
    if (!clsEl || !secSelect) return;
    const cls = clsEl.value;
    
    secSelect.innerHTML = includeAllOption ? '<option value="All Sections">All Sections</option>' : '<option value="">-- All Sections --</option>';
    
    if (!cls || cls === 'All Classes') {
      return;
    }
    
    try {
      const sections = await apiCall(`/students/sections/${cls}`);
      sections.forEach(s => {
        secSelect.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`;
      });
      if (includeAllOption) {
        secSelect.innerHTML += '<option value="No Section">No Section</option>';
      }
    } catch (err) {}
  }

  // Load configuration details for a specific option panel
  function loadFeePanelData(opt) {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });

    if (opt === 'pay-fee') {
      // Auto-load unpaid ledgers when pay-fee panel opens
      const paySearchBtn = document.getElementById('btn-search-pay-ledger');
      if (paySearchBtn) paySearchBtn.click();
    }
    else if (opt === 'fee-history') {
      // Setup history filters
      const yearSelect = document.getElementById('history-filter-year');
      if (yearSelect) {
        yearSelect.innerHTML = '';
        for (let y = currentYear; y >= currentYear - 5; y--) {
          yearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
        yearSelect.value = currentYear;
      }
      const monthSelect = document.getElementById('history-filter-month');
      if (monthSelect) monthSelect.value = currentMonth;
      const classSelect = document.getElementById('history-filter-class');
      if (classSelect) classSelect.value = 'All Classes';
      
      updateSectionDropdown('history-filter-class', 'history-filter-section', true);
      const hTableBody = document.querySelector('#table-history-ledgers tbody');
      if (hTableBody) {
        hTableBody.innerHTML = '<tr><td colspan="13" style="text-align: center; color: var(--text-muted);">Select filters and click Load Ledger...</td></tr>';
      }
    } 
    else if (opt === 'class-fee') {
      loadClassFeeRules();
    }
    else if (opt === 'student-fee') {
      const sClass = document.getElementById('student-fee-class');
      if (sClass) sClass.value = 'All Classes';
      updateSectionDropdown('student-fee-class', 'student-fee-section', true);
      const sSearch = document.getElementById('student-fee-search');
      if (sSearch) sSearch.value = '';
      loadStudentFeeList();
    }
    else if (opt === 'generate-reminder') {
      // Initialize reminder year
      const reminderYearSelect = document.getElementById('reminder-filter-year');
      if (reminderYearSelect) {
        reminderYearSelect.innerHTML = '';
        for (let y = currentYear; y >= currentYear - 5; y--) {
          reminderYearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
      }
      // Initialize slip year (inside same panel)
      const slipYearSelect = document.getElementById('slip-year');
      if (slipYearSelect) {
        slipYearSelect.innerHTML = '';
        for (let y = currentYear; y >= currentYear - 5; y--) {
          slipYearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
        slipYearSelect.value = currentYear;
      }
      // Reset slip search and containers
      const searchInput = document.getElementById('slip-search');
      if (searchInput) searchInput.value = '';
      const listContainer = document.getElementById('slip-student-list-container');
      if (listContainer) listContainer.style.display = 'block';
      const previewContainer = document.getElementById('slip-preview-container');
      if (previewContainer) previewContainer.style.display = 'none';
      // Reset reminder preview
      const reminderPreview = document.getElementById('reminder-preview-container');
      if (reminderPreview) reminderPreview.style.display = 'none';
      const reminderCards = document.querySelectorAll('#tab-reminder-form .card');
      if (reminderCards.length) reminderCards.forEach(c => c.style.display = '');
      // Load saved reminders
      loadSavedReminders();
    }
    else if (opt === 'fee-analytics') {
      // Setup analytics filters
      const yearSelect = document.getElementById('analytics-filter-year');
      if (yearSelect) {
        yearSelect.innerHTML = '';
        for (let y = currentYear; y >= currentYear - 5; y--) {
          yearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
        yearSelect.value = currentYear;
      }
      const monthSelect = document.getElementById('analytics-filter-month');
      if (monthSelect) monthSelect.value = currentMonth;
      refreshFeeAnalytics();
    }
  }

  // Load Fee setup rules (Tuition settings)
  async function loadClassFeeRules() {
    try {
      const fees = await apiCall('/fees/setup');
      const tbody = document.querySelector('#table-fee-setup-rules tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (fees.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" style="text-align: center; color:var(--text-muted);">No fee configurations found.</td></tr>';
        return;
      }

      fees.forEach(f => {
        tbody.innerHTML += `
          <tr>
            <td><strong>${f.class_name}</strong></td>
            <td><strong>${f.monthly_fee.toLocaleString()} PKR</strong></td>
          </tr>
        `;
      });
    } catch (e) {}
  }

  // Save new Tuition fee rule
  const formFeeSetup = document.getElementById('form-fee-setup');
  if (formFeeSetup) {
    formFeeSetup.addEventListener('submit', async (e) => {
      e.preventDefault();
      const class_name = document.getElementById('fee-setup-class').value.trim();
      const monthly_fee = document.getElementById('fee-setup-amount').value;

      try {
        const res = await apiCall('/fees/setup', 'POST', { class_name, monthly_fee });
        showToast(res.message);
        formFeeSetup.reset();
        loadClassFeeRules();
      } catch (err) {}
    });
  }

  // Search Pending Invoices (Pay Fee)
  const btnSearchPayLedger = document.getElementById('btn-search-pay-ledger');
  if (btnSearchPayLedger) {
    btnSearchPayLedger.addEventListener('click', async () => {
      const search = document.getElementById('fee-pay-search').value.trim();
      const status = document.getElementById('fee-pay-filter-status').value;

      let endpoint = '/fees/ledger?';
      if (status) endpoint += `status=${status}&`;

      try {
        const ledgers = await apiCall(endpoint);
        const tbody = document.querySelector('#table-unpaid-ledgers tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const filtered = ledgers.filter(l => {
          if (!search) return true;
          const s = search.toLowerCase();
          return l.student_name.toLowerCase().includes(s) || l.roll_no.toLowerCase().includes(s) || l.class_name.toLowerCase().includes(s);
        });

        if (filtered.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color:var(--text-muted);">No unpaid ledger records matches search.</td></tr>';
          return;
        }

        filtered.forEach(l => {
          const remaining = l.total_payable - l.paid_amount;
          let badgeClass = 'status-unpaid';
          if (l.status === 'Partial') badgeClass = 'status-partial';

          tbody.innerHTML += `
            <tr>
              <td>
                <div style="font-weight:700;">${l.student_name}</div>
                <div style="font-size:0.8rem; color:var(--text-muted);">Roll: ${l.roll_no || 'N/A'} | Father: ${l.father_name || '-'}</div>
              </td>
              <td>${l.class_name}</td>
              <td><strong>${l.month} ${l.year}</strong></td>
              <td>${l.total_payable.toLocaleString()} Rs</td>
              <td>${l.paid_amount.toLocaleString()} Rs</td>
              <td><strong style="color:var(--secondary);">${remaining.toLocaleString()} Rs</strong></td>
              <td><span class="status-badge ${badgeClass}">${l.status}</span></td>
              <td>
                <button class="btn btn-primary btn-sm btn-record-tx" 
                  data-id="${l.id}" 
                  data-name="${l.student_name}" 
                  data-month="${l.month} ${l.year}" 
                  data-due="${remaining}">Collect Fee</button>
              </td>
            </tr>
          `;
        });

        attachFeePaymentFormEvents();
      } catch (e) {}
    });
  }

  // Collect modal form bindings
  const modalTx = document.getElementById('modal-transaction');
  function attachFeePaymentFormEvents() {
    document.querySelectorAll('.btn-record-tx').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const month = btn.getAttribute('data-month');
        const due = btn.getAttribute('data-due');

        document.getElementById('tx-ledger-id').value = id;
        document.getElementById('tx-student-name').innerText = name;
        document.getElementById('tx-month-year').innerText = month;
        document.getElementById('tx-total-payable').innerText = parseFloat(due).toLocaleString();
        document.getElementById('tx-pay-amount').value = Math.round(due);
        document.getElementById('tx-pay-date').value = new Date().toISOString().split('T')[0];

        modalTx.classList.add('open');
      });
    });
  }

  const btnCloseTxModal = document.getElementById('btn-close-tx-modal');
  if (btnCloseTxModal) {
    btnCloseTxModal.addEventListener('click', () => {
      modalTx.classList.remove('open');
    });
  }

  const formFeePayRecord = document.getElementById('form-fee-pay-record');
  if (formFeePayRecord) {
    formFeePayRecord.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ledger_id = document.getElementById('tx-ledger-id').value;
      const amount_paid = document.getElementById('tx-pay-amount').value;
      const payment_date = document.getElementById('tx-pay-date').value;

      try {
        const res = await apiCall('/fees/pay', 'POST', { ledger_id, amount_paid, payment_date });
        showToast(res.message);
        modalTx.classList.remove('open');
        refreshAllFeeViews();
      } catch (err) {}
    });
  }

  // Helper: Refresh all fee-related views after any change
  function refreshAllFeeViews() {
    loadDashboardStats();
    const paySearchBtn = document.getElementById('btn-search-pay-ledger');
    if (paySearchBtn) paySearchBtn.click();
    const histYear = document.getElementById('history-filter-year');
    const histMonth = document.getElementById('history-filter-month');
    if (histYear && histYear.value && histMonth && histMonth.value) {
      loadHistoryLedger();
    }
    refreshFeeAnalytics();
  }

  // ==========================================
  // FEE HISTORY LOGIC (Option 2)
  // ==========================================
  async function loadHistoryLedger() {
    const cls = document.getElementById('history-filter-class').value;
    const sec = document.getElementById('history-filter-section').value;
    const month = document.getElementById('history-filter-month').value;
    const year = document.getElementById('history-filter-year').value;

    let url = `/fees/history-management?month=${month}&year=${year}`;
    if (cls && cls !== 'All Classes') url += `&class_name=${encodeURIComponent(cls)}`;
    if (sec && sec !== 'All Sections') url += `&section_name=${encodeURIComponent(sec)}`;

    try {
      const data = await apiCall(url);
      const tbody = document.querySelector('#table-history-ledgers tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.length === 0) {
        tbody.innerHTML = '<tr><td colspan="13" style="text-align: center;">No records found for the selection.</td></tr>';
        return;
      }

      data.forEach(l => {
        const hasLedger = l.ledger_id !== null;
        let badge = '-';
        if (l.status === 'Paid') badge = '<span class="status-badge status-present">PAID</span>';
        else if (l.status === 'Partial') badge = '<span class="status-badge status-partial">PARTIAL</span>';
        else if (l.status === 'Unpaid') badge = '<span class="status-badge status-absent">UNPAID</span>';

        const actionBtn = hasLedger
          ? `<button class="btn btn-danger btn-sm btn-delete-history-ledger" data-id="${l.ledger_id}">Delete</button>`
          : `<button class="btn btn-outline btn-success btn-sm btn-generate-history-ledger" data-student-id="${l.student_id}">Generate</button>`;

        tbody.innerHTML += `
          <tr>
            <td>${l.student_id}</td>
            <td>${l.roll_no || 'N/A'}</td>
            <td><strong>${l.name}</strong></td>
            <td>${l.father_name || '-'}</td>
            <td>${hasLedger ? l.base_fee.toLocaleString() : '-'}</td>
            <td>${hasLedger ? l.discount.toLocaleString() : '-'}</td>
            <td>${hasLedger ? l.transport_fee.toLocaleString() : '-'}</td>
            <td>${hasLedger ? l.monthly_fee.toLocaleString() : '-'}</td>
            <td style="text-align: center;">
              <input type="number" class="editable-due-input ${hasLedger ? 'has-ledger' : ''}" 
                data-student-id="${l.student_id}" 
                data-ledger-id="${l.ledger_id || ''}" 
                value="${l.previous_due || 0}">
            </td>
            <td>${hasLedger ? (l.total_payable - l.paid_amount).toLocaleString() : '-'}</td>
            <td>${hasLedger ? l.paid_amount.toLocaleString() : '-'}</td>
            <td>${badge}</td>
            <td>${actionBtn}</td>
          </tr>
        `;
      });

      // Bind single generate/delete buttons
      document.querySelectorAll('.btn-generate-history-ledger').forEach(btn => {
        btn.addEventListener('click', async () => {
          const student_id = btn.getAttribute('data-student-id');
          try {
            const res = await apiCall('/fees/generate-single', 'POST', { student_id, month, year });
            showToast(res.message);
            refreshAllFeeViews();
          } catch (e) {}
        });
      });

      document.querySelectorAll('.btn-delete-history-ledger').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ledger_id = btn.getAttribute('data-id');
          if (!confirm('Are you sure you want to delete this student\'s ledger for this month?')) return;
          try {
            const res = await apiCall(`/fees/ledger/${ledger_id}`, 'DELETE');
            showToast(res.message);
            refreshAllFeeViews();
          } catch (e) {}
        });
      });

    } catch (e) {
      console.error('loadHistoryLedger error:', e);
      showToast('Failed to load fee ledger: ' + (e.message || 'Unknown error'), true);
    }
  }

  const btnLoadHistoryLedger = document.getElementById('btn-load-history-ledger');
  if (btnLoadHistoryLedger) {
    btnLoadHistoryLedger.addEventListener('click', loadHistoryLedger);
  }

  // Bulk ledger generation
  const btnGenerateBulkLedger = document.getElementById('btn-generate-bulk-ledger');
  if (btnGenerateBulkLedger) {
    btnGenerateBulkLedger.addEventListener('click', async () => {
      const month = document.getElementById('history-filter-month').value;
      const year = document.getElementById('history-filter-year').value;
      if (!confirm(`Generate monthly ledgers for ${month} ${year}?`)) return;

      try {
        const res = await apiCall('/fees/generate', 'POST', { month, year });
        showToast(res.message);
        refreshAllFeeViews();
      } catch (e) {}
    });
  }

  // Bulk save dues
  const btnSaveHistoryDues = document.getElementById('btn-save-history-dues');
  if (btnSaveHistoryDues) {
    btnSaveHistoryDues.addEventListener('click', async () => {
      const inputs = document.querySelectorAll('#table-history-ledgers tbody input.editable-due-input');
      const changes = [];
      inputs.forEach(inp => {
        changes.push({
          student_id: parseInt(inp.getAttribute('data-student-id')),
          ledger_id: inp.getAttribute('data-ledger-id') ? parseInt(inp.getAttribute('data-ledger-id')) : null,
          previous_due: parseFloat(inp.value) || 0
        });
      });

      try {
        const res = await apiCall('/fees/save-history-dues', 'POST', { changes });
        showToast(res.message);
        refreshAllFeeViews();
      } catch (e) {}
    });
  }

  // Bulk delete ledger
  const btnDeleteBulkLedger = document.getElementById('btn-delete-bulk-ledger');
  if (btnDeleteBulkLedger) {
    btnDeleteBulkLedger.addEventListener('click', async () => {
      const cls = document.getElementById('history-filter-class').value;
      const sec = document.getElementById('history-filter-section').value;
      const month = document.getElementById('history-filter-month').value;
      const year = document.getElementById('history-filter-year').value;

      if (!confirm(`Are you sure you want to delete ALL generated ledgers for ${month} ${year}?`)) return;

      let url = `/fees/ledger-bulk?month=${month}&year=${year}`;
      if (cls && cls !== 'All Classes') url += `&class_name=${encodeURIComponent(cls)}`;
      if (sec && sec !== 'All Sections') url += `&section_name=${encodeURIComponent(sec)}`;

      try {
        const res = await apiCall(url, 'DELETE');
        showToast(res.message);
        refreshAllFeeViews();
      } catch (e) {}
    });
  }

  // ==========================================
  // STUDENT FEE MANAGER LOGIC (Option 4)
  // ==========================================
  async function loadStudentFeeList() {
    const cls = document.getElementById('student-fee-class').value;
    const sec = document.getElementById('student-fee-section').value;
    const search = document.getElementById('student-fee-search').value.trim();

    let url = '/students?';
    if (cls && cls !== 'All Classes') url += `class_name=${encodeURIComponent(cls)}&`;
    if (sec && sec !== 'All Sections') url += `section_name=${encodeURIComponent(sec)}&`;
    if (search) url += `search=${encodeURIComponent(search)}&`;

    try {
      const list = await apiCall(url);
      const tbody = document.querySelector('#table-student-fee-list tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No students found matching selection.</td></tr>';
        return;
      }

      list.forEach(s => {
        let siblingText = 'Primary Head';
        if (s.family_head_id) siblingText = `Sibling (Head ID: ${s.family_head_id})`;

        let waiverType = 'none';
        let discountVal = 0;
        if (s.is_free === 1) {
          waiverType = 'free';
        } else if (s.discount_amount > 0) {
          waiverType = 'amount';
          discountVal = s.discount_amount;
        } else if (s.discount_percent > 0) {
          waiverType = 'percent';
          discountVal = s.discount_percent;
        }

        const isValDisabled = waiverType === 'none' || waiverType === 'free';

        tbody.innerHTML += `
          <tr data-student-id="${s.id}">
            <td>${s.roll_no || 'N/A'}</td>
            <td><strong>${s.name}</strong></td>
            <td>${s.class_name} ${s.section_name ? '('+s.section_name+')' : ''}</td>
            <td><span style="font-size:0.85rem; color:var(--text-muted);">${siblingText}</span></td>
            <td>
              <select class="form-control val-waiver-type" style="padding:6px; font-size:0.85rem;">
                <option value="none" ${waiverType === 'none' ? 'selected' : ''}>None</option>
                <option value="free" ${waiverType === 'free' ? 'selected' : ''}>Free Education</option>
                <option value="amount" ${waiverType === 'amount' ? 'selected' : ''}>Discount Amount (Rs)</option>
                <option value="percent" ${waiverType === 'percent' ? 'selected' : ''}>Discount Percent (%)</option>
              </select>
            </td>
            <td>
              <input type="number" class="form-control val-discount-value" style="padding:6px; font-size:0.85rem; width:80px;" 
                value="${discountVal}" ${isValDisabled ? 'disabled' : ''}>
            </td>
            <td>
              <input type="number" class="form-control val-transport-fee" style="padding:6px; font-size:0.85rem; width:100px;" 
                value="${s.transport_fee || 0}">
            </td>
            <td>
              <button class="btn btn-primary btn-sm btn-save-student-fee" data-id="${s.id}">Save</button>
            </td>
          </tr>
        `;
      });

      // Bind waiver select change to toggle discount input
      document.querySelectorAll('.val-waiver-type').forEach(sel => {
        sel.addEventListener('change', (e) => {
          const row = sel.closest('tr');
          const type = e.target.value;
          const valInput = row.querySelector('.val-discount-value');
          if (type === 'none' || type === 'free') {
            valInput.value = 0;
            valInput.disabled = true;
          } else {
            valInput.disabled = false;
          }
        });
      });

      // Bind save buttons
      document.querySelectorAll('.btn-save-student-fee').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          const row = btn.closest('tr');
          const type = row.querySelector('.val-waiver-type').value;
          const discountVal = parseFloat(row.querySelector('.val-discount-value').value) || 0;
          const transport_fee = parseFloat(row.querySelector('.val-transport-fee').value) || 0;

          let is_free = 0;
          let discount_amount = 0;
          let discount_percent = 0;

          if (type === 'free') {
            is_free = 1;
          } else if (type === 'amount') {
            discount_amount = discountVal;
          } else if (type === 'percent') {
            discount_percent = discountVal;
          }

          try {
            const res = await apiCall('/fees/student-settings', 'POST', {
              student_id: id,
              is_free,
              discount_amount,
              discount_percent,
              transport_fee
            });
            showToast(res.message);
            loadStudentFeeList();
          } catch (e) {}
        });
      });

    } catch (e) {}
  }

  const btnLoadStudentFeeList = document.getElementById('btn-load-student-fee-list');
  if (btnLoadStudentFeeList) {
    btnLoadStudentFeeList.addEventListener('click', loadStudentFeeList);
  }

  // ==========================================
  // FEE REMINDER LOGIC (Option 5)
  // ==========================================
  let reminderStudentsData = [];

  const btnLoadReminders = document.getElementById('btn-load-reminders');
  if (btnLoadReminders) {
    btnLoadReminders.addEventListener('click', async () => {
      const cls = document.getElementById('reminder-filter-class').value;
      const sec = document.getElementById('reminder-filter-section').value;
      const year = document.getElementById('reminder-filter-year').value;

      if (!year) { showToast('Select a year first', true); return; }

      try {
        let url = `/fees/unpaid-students?year=${year}`;
        if (cls) url += `&class_name=${encodeURIComponent(cls)}`;
        if (sec) url += `&section_name=${encodeURIComponent(sec)}`;

        reminderStudentsData = await apiCall(url);
        const tbody = document.querySelector('#table-reminder-students tbody');
        if (!tbody) return;

        if (reminderStudentsData.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No students found for this selection.</td></tr>';
          return;
        }

        tbody.innerHTML = reminderStudentsData.map(s => {
          const hasLedger = s.ledger_entries > 0;
          const unpaidAmount = s.total_unpaid || 0;
          const statusBadge = hasLedger
            ? (unpaidAmount > 0 ? '<span class="badge badge-red">Unpaid</span>' : '<span class="badge badge-green">Paid</span>')
            : '<span class="badge badge-yellow">No Ledger</span>';

          return `
            <tr style="${!hasLedger ? 'opacity: 0.6;' : ''}">
              <td><input type="checkbox" class="reminder-check" data-id="${s.id}" ${hasLedger && unpaidAmount > 0 ? 'checked' : ''}></td>
              <td>${s.roll_no || 'N/A'}</td>
              <td><strong>${s.name}</strong></td>
              <td>${s.class_name} ${s.section_name ? '(' + s.section_name + ')' : ''}</td>
              <td>${s.father_name || '-'}</td>
              <td>${statusBadge} <strong>${unpaidAmount > 0 ? unpaidAmount.toLocaleString() : ''}</strong></td>
            </tr>
          `;
        }).join('');
      } catch (e) {
        showToast('Failed to load students: ' + e.message, true);
      }
    });
  }

  document.getElementById('reminder-check-all')?.addEventListener('change', (e) => {
    document.querySelectorAll('.reminder-check').forEach(cb => { cb.checked = e.target.checked; });
  });

  document.getElementById('btn-select-all-reminders')?.addEventListener('click', () => {
    document.querySelectorAll('.reminder-check').forEach(cb => { cb.checked = true; });
  });

  document.getElementById('btn-deselect-all-reminders')?.addEventListener('click', () => {
    document.querySelectorAll('.reminder-check').forEach(cb => { cb.checked = false; });
  });

  function buildReminderHTML(studentData, schoolData, year) {
    const allMonths = ['Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb'];
    const d = studentData;

    // Only include months that have actual ledger data (not null)
    const activeMonths = allMonths.filter(m => d.monthlyFee[m] !== null && d.monthlyFee[m] !== undefined);

    if (activeMonths.length === 0) {
      return `
        <div class="fee-slip">
          <div class="slip-header">
            <img src="/${schoolData.logo || 'school_assets/school_logo.png'}" class="slip-logo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect width=%2236%22 height=%2236%22 fill=%22%236366f1%22/><text x=%2218%22 y=%2224%22 font-size=%2216%22 fill=%22white%22 text-anchor=%22middle%22>SS</text></svg>'">
            <div class="slip-header-text">
              <h2>${schoolData.name || 'School Name'}</h2>
              <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
            </div>
          </div>
          <div class="slip-student-row">
            <div class="slip-student-info">
              <div><strong>Name:</strong> ${d.student.name}</div>
              <div><strong>F-Name:</strong> ${d.student.father_name || '-'}</div>
              <div><strong>Class:</strong> ${d.student.class_name}${d.student.section_name ? ' (' + d.student.section_name + ')' : ''}</div>
            </div>
            <div class="slip-student-info">
              <div><strong>Roll No:</strong> ${d.student.roll_no || '-'}</div>
              <div><strong>ID:</strong> ${d.student.admission_no || d.student.id}</div>
            </div>
            <div class="slip-badge">FEE REMINDER ${year}-${parseInt(year)+1}</div>
          </div>
          <div style="text-align: center; padding: 20px; color: #666;">No fee ledger data found for this year.</div>
        </div>
      `;
    }

    let tableRows = '';
    const rows = [
      { label: 'Mnth Fee', data: d.monthlyFee },
      { label: 'Transport', data: d.transportFee },
      { label: 'Due', data: d.due },
      { label: 'Total', data: d.total },
      { label: 'Paid', data: d.paid },
      { label: 'Unpaid', data: d.unpaid }
    ];

    rows.forEach(row => {
      let tr = `<tr><td>${row.label}</td>`;
      activeMonths.forEach(m => {
        const val = row.data[m];
        tr += `<td>${val !== null && val !== undefined ? val.toLocaleString() : '-'}</td>`;
      });
      tr += '</tr>';
      tableRows += tr;
    });

    return `
      <div class="fee-slip">
        <div class="slip-header">
          <img src="/${schoolData.logo || 'school_assets/school_logo.png'}" class="slip-logo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect width=%2236%22 height=%2236%22 fill=%22%236366f1%22/><text x=%2218%22 y=%2224%22 font-size=%2216%22 fill=%22white%22 text-anchor=%22middle%22>SS</text></svg>'">
          <div class="slip-header-text">
            <h2>${schoolData.name || 'School Name'}</h2>
            <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
          </div>
        </div>
        <div class="slip-student-row">
          <div class="slip-student-info">
            <div><strong>Name:</strong> ${d.student.name}</div>
            <div><strong>F-Name:</strong> ${d.student.father_name || '-'}</div>
            <div><strong>Class:</strong> ${d.student.class_name}${d.student.section_name ? ' (' + d.student.section_name + ')' : ''}</div>
          </div>
          <div class="slip-student-info">
            <div><strong>Roll No:</strong> ${d.student.roll_no || '-'}</div>
            <div><strong>ID:</strong> ${d.student.admission_no || d.student.id}</div>
          </div>
          <div class="slip-badge">FEE REMINDER ${year}-${parseInt(year)+1}</div>
        </div>
        <div class="table-container" style="border: 2px solid #000; background: #fff;">
          <table class="data-table" style="color: #000;">
            <thead>
              <tr style="background: #f0f0f0;">
                <th></th>
                ${activeMonths.map(m => `<th>${m}</th>`).join('')}
              </tr>
            </thead>
            <tbody style="color: #000;">${tableRows}</tbody>
          </table>
        </div>
        <div class="slip-footer">
          <div class="slip-sign">Principal Sign: _______________</div>
          <div class="slip-net-total">NET TOTAL: ${d.netTotal.toLocaleString()}</div>
        </div>
      </div>
    `;
  }

  const btnGenerateReminders = document.getElementById('btn-generate-reminders');
  if (btnGenerateReminders) {
    btnGenerateReminders.addEventListener('click', async () => {
      const year = document.getElementById('reminder-filter-year').value;
      const selectedIds = [];
      document.querySelectorAll('.reminder-check:checked').forEach(cb => {
        selectedIds.push(parseInt(cb.dataset.id));
      });

      if (selectedIds.length === 0) {
        showToast('Select at least one student', true);
        return;
      }

      const a4Page = document.getElementById('reminder-a4-page');
      a4Page.innerHTML = '';

      try {
        const allData = await Promise.all(
          selectedIds.map(id => apiCall(`/fees/slip/${id}?year=${year}`))
        );

        allData.forEach(data => {
          a4Page.innerHTML += buildReminderHTML(data, data.school, year);
        });

        document.querySelector('#tab-reminder-form .card').style.display = 'none';
        document.getElementById('reminder-preview-container').style.display = 'block';
      } catch (e) {
        showToast('Failed to generate reminders: ' + e.message, true);
      }
    });
  }

  document.getElementById('btn-back-reminder-list')?.addEventListener('click', () => {
    document.querySelector('#tab-reminder-form .card').style.display = '';
    document.getElementById('reminder-preview-container').style.display = 'none';
  });

  document.getElementById('btn-print-reminders')?.addEventListener('click', async () => {
    const a4Page = document.getElementById('reminder-a4-page');
    const printHTML = a4Page.innerHTML;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html><head><title>Fee Reminders</title>
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: Arial, sans-serif; }
        @page { size: A4; margin: 10mm; }
        .a4-page {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          padding: 5mm;
          page-break-after: always;
        }
        .fee-slip { border: 2px solid #000; padding: 6px; color: #000; font-size: 0.65rem; break-inside: avoid; page-break-inside: avoid; }
        .slip-header { display: flex; align-items: center; gap: 6px; border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 4px; }
        .slip-logo { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
        .slip-header-text h2 { font-size: 0.6rem; font-weight: 800; margin: 0; text-transform: uppercase; }
        .slip-header-text p { font-size: 0.5rem; margin: 1px 0 0; }
        .slip-student-row { display: flex; justify-content: space-between; gap: 6px; margin-bottom: 4px; padding: 4px; border: 1px solid #ccc; border-radius: 2px; }
        .slip-student-info { font-size: 0.55rem; line-height: 1.4; }
        .slip-student-info strong { display: inline-block; min-width: 35px; }
        .slip-badge { background: #000; color: #fff; padding: 3px 6px; font-weight: 700; font-size: 0.5rem; white-space: nowrap; }
        table { width: 100%; border-collapse: collapse; border: 1px solid #000; }
        th, td { padding: 2px 3px; font-size: 0.5rem; border: 1px solid #ccc; text-align: center; }
        th { background: #f5f5f5; font-weight: 700; }
        td:first-child { text-align: left; font-weight: 600; background: #f9f9f9; font-size: 0.48rem; }
        .slip-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; padding-top: 3px; border-top: 2px solid #000; }
        .slip-sign { font-size: 0.5rem; }
        .slip-net-total { background: #000; color: #fff; padding: 2px 8px; font-weight: 800; font-size: 0.55rem; }
      </style></head><body><div class="a4-page">${printHTML}</div></body></html>
    `);
    printWindow.document.close();
    printWindow.print();
  });

  // Save reminders
  let currentReminderData = null;

  // Save as PDF
  document.getElementById('btn-save-pdf-reminders')?.addEventListener('click', async () => {
    const year = document.getElementById('reminder-filter-year').value;
    const cls = document.getElementById('reminder-filter-class').value;
    const selectedIds = [];
    document.querySelectorAll('.reminder-check:checked').forEach(cb => {
      selectedIds.push(parseInt(cb.dataset.id));
    });

    if (selectedIds.length === 0) {
      showToast('No students selected', true);
      return;
    }

    const statusEl = document.getElementById('reminder-save-status');
    statusEl.textContent = 'Generating PDF...';
    statusEl.style.color = 'var(--accent)';

    try {
      const result = await apiCall('/fees/reminders/generate-pdf', 'POST', {
        student_ids: selectedIds,
        year: parseInt(year),
        title: `Fee Reminder - ${cls || 'All'} - ${year}`
      });

      const downloadUrl = result.file_path;
      statusEl.innerHTML = `PDF ready! <a href="${downloadUrl}" target="_blank" style="color: var(--accent); text-decoration: underline; font-weight: 700;">Click to Download</a>`;

      // Auto-download
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = result.file_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      showToast(`PDF generated for ${result.student_count} students`);
    } catch (err) {
      statusEl.textContent = 'Failed to generate PDF';
      statusEl.style.color = 'var(--danger)';
      showToast('Failed: ' + err.message, true);
    }
  });

  document.getElementById('btn-save-reminders')?.addEventListener('click', async () => {
    const cls = document.getElementById('reminder-filter-class').value;
    const sec = document.getElementById('reminder-filter-section').value;
    const year = document.getElementById('reminder-filter-year').value;
    const selectedIds = [];
    let totalAmount = 0;
    document.querySelectorAll('.reminder-check:checked').forEach(cb => {
      selectedIds.push(parseInt(cb.dataset.id));
      const student = reminderStudentsData.find(s => s.id == cb.dataset.id);
      if (student) totalAmount += student.total_unpaid;
    });

    if (selectedIds.length === 0) {
      showToast('No students selected', true);
      return;
    }

    try {
      const result = await apiCall('/fees/reminders', 'POST', {
        title: `Fee Reminder - ${cls || 'All Classes'} - ${year}`,
        class_name: cls,
        section_name: sec,
        year: parseInt(year),
        student_ids: selectedIds,
        total_amount: totalAmount,
        student_count: selectedIds.length
      });
      showToast('Reminder saved successfully');
      document.getElementById('reminder-save-status').textContent = 'Saved!';
      setTimeout(() => { document.getElementById('reminder-save-status').textContent = ''; }, 3000);
      loadSavedReminders();
    } catch (err) {
      showToast('Failed to save: ' + err.message, true);
    }
  });

  async function loadSavedReminders() {
    try {
      const reminders = await apiCall('/fees/reminders');
      const tbody = document.querySelector('#table-saved-reminders tbody');
      if (!tbody) return;

      if (reminders.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No saved reminders yet.</td></tr>';
        return;
      }

      tbody.innerHTML = reminders.map(r => `
        <tr>
          <td><strong>${r.title || 'Untitled'}</strong></td>
          <td>${r.class_name || 'All'}</td>
          <td>${r.year}</td>
          <td>${r.student_count}</td>
          <td>${r.total_amount ? r.total_amount.toLocaleString() : '0'}</td>
          <td>${r.created_at ? new Date(r.created_at).toLocaleDateString() : '-'}</td>
          <td>${r.printed_at ? new Date(r.printed_at).toLocaleDateString() : 'Not printed'}</td>
          <td>
            <button class="btn btn-outline btn-sm btn-view-reminder" data-id="${r.id}" data-student-ids='${r.student_ids}' data-year="${r.year}">View</button>
            <button class="btn btn-danger btn-sm btn-delete-reminder" data-id="${r.id}">Delete</button>
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.btn-view-reminder').forEach(btn => {
        btn.addEventListener('click', async () => {
          const studentIds = JSON.parse(btn.dataset.studentIds || '[]');
          const year = btn.dataset.year;
          if (studentIds.length === 0) { showToast('No students in this reminder', true); return; }

          const a4Page = document.getElementById('reminder-a4-page');
          a4Page.innerHTML = '';

          try {
            const allData = await Promise.all(
              studentIds.map(id => apiCall(`/fees/slip/${id}?year=${year}`))
            );
            allData.forEach(data => {
              a4Page.innerHTML += buildReminderHTML(data, data.school, year);
            });

            document.querySelector('#tab-reminder-form .card').style.display = 'none';
            document.getElementById('reminder-preview-container').style.display = 'block';

            await apiCall(`/fees/reminders/${btn.dataset.id}/print`, 'PUT');
            loadSavedReminders();
          } catch (e) {
            showToast('Failed to load reminder: ' + e.message, true);
          }
        });
      });

      tbody.querySelectorAll('.btn-delete-reminder').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this saved reminder?')) return;
          try {
            await apiCall(`/fees/reminders/${btn.dataset.id}`, 'DELETE');
            showToast('Reminder deleted');
            loadSavedReminders();
          } catch (e) { showToast(e.message, true); }
        });
      });
    } catch (e) {}
  }

  // ==========================================
  // FEE ANALYTICS LOGIC (Option 6)
  // ==========================================
  async function refreshFeeAnalytics() {
    const month = document.getElementById('analytics-filter-month').value;
    const year = document.getElementById('analytics-filter-year').value;

    try {
      const data = await apiCall(`/fees/analytics?month=${month}&year=${year}`);
      const tbody = document.querySelector('#table-analytics-class-summary tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.classWise.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No data found.</td></tr>';
        return;
      }

      data.classWise.forEach(c => {
        let badgeColor = '#ff5252'; // Poor
        let statusIcon = '●';
        if (c.status === 'Good') {
          badgeColor = '#4caf50';
          statusIcon = '●';
        } else if (c.status === 'Fair') {
          badgeColor = '#ffb142';
          statusIcon = '●';
        }

        const isTrendPositive = !c.trend.startsWith('-');
        const trendIcon = isTrendPositive ? '▲' : '▼';
        const trendColor = isTrendPositive ? '#4caf50' : '#ff5252';

        tbody.innerHTML += `
          <tr>
            <td><strong>${c.class_name}</strong></td>
            <td>${c.total_students}</td>
            <td style="color:#ff5252; font-weight:500;">${c.total_due.toLocaleString()} Rs</td>
            <td style="color:#4caf50; font-weight:500;">${c.total_collected.toLocaleString()} Rs</td>
            <td style="color:#ffb142; font-weight:500;">${c.remaining_balance.toLocaleString()} Rs</td>
            <td style="color:#2196f3; font-weight:700;">${c.collection_rate}%</td>
            <td><span style="color:${badgeColor}; font-weight:bold;">${statusIcon} ${c.status}</span></td>
            <td style="color:${trendColor}; font-weight:500;">${trendIcon} ${c.trend}</td>
          </tr>
        `;
      });

      // Update bottom totals label
      const sTotals = document.getElementById('analytics-class-summary-totals');
      if (sTotals) {
        sTotals.innerHTML = `
          <span style="color: #ff5252;">Total Due: Rs. ${data.schoolWise.total_due.toLocaleString()}</span>
          <span style="color: #4caf50;">Total Collected: Rs. ${data.schoolWise.total_collected.toLocaleString()}</span>
          <span style="color: #ffb142;">Total Remaining: Rs. ${data.schoolWise.total_remaining.toLocaleString()}</span>
          <span style="color: #2196f3;">Overall Collection: ${data.schoolWise.overall_collection_rate}%</span>
        `;
      }

      // Update School-wise Analysis Tab Stats
      const statSchoolDue = document.getElementById('stat-school-due');
      if (statSchoolDue) statSchoolDue.innerText = `${data.schoolWise.total_due.toLocaleString()} PKR`;
      const statSchoolCollected = document.getElementById('stat-school-collected');
      if (statSchoolCollected) statSchoolCollected.innerText = `${data.schoolWise.total_collected.toLocaleString()} PKR`;
      const statSchoolRemaining = document.getElementById('stat-school-remaining');
      if (statSchoolRemaining) statSchoolRemaining.innerText = `${data.schoolWise.total_remaining.toLocaleString()} PKR`;
      const statSchoolRate = document.getElementById('stat-school-rate');
      if (statSchoolRate) statSchoolRate.innerText = `${data.schoolWise.overall_collection_rate}%`;

      // Render Chart.js Bar Chart
      renderAnalyticsChart(data.classWise);

    } catch (e) {}
  }

  const btnRefreshAnalytics = document.getElementById('btn-refresh-analytics');
  if (btnRefreshAnalytics) {
    btnRefreshAnalytics.addEventListener('click', refreshFeeAnalytics);
  }

  function renderAnalyticsChart(classWiseData) {
    const chartCanvas = document.getElementById('chart-collection-rate');
    if (!chartCanvas) return;

    if (collectionChartInstance) {
      collectionChartInstance.destroy();
    }

    const ctx = chartCanvas.getContext('2d');
    const labels = classWiseData.map(c => c.class_name);
    const dataValues = classWiseData.map(c => c.collection_rate);
    const backgroundColors = classWiseData.map(c => {
      if (c.status === 'Good') return 'rgba(76, 175, 80, 0.85)'; // Green
      if (c.status === 'Fair') return 'rgba(255, 177, 66, 0.85)'; // Orange
      return 'rgba(255, 82, 82, 0.85)'; // Red
    });
    const borderColors = classWiseData.map(c => {
      if (c.status === 'Good') return '#4caf50';
      if (c.status === 'Fair') return '#ffb142';
      return '#ff5252';
    });

    collectionChartInstance = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: 'Collection %',
          data: dataValues,
          backgroundColor: backgroundColors,
          borderColor: borderColors,
          borderWidth: 1.5,
          borderRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            min: 0,
            max: 100,
            grid: {
              color: 'rgba(255, 255, 255, 0.08)'
            },
            ticks: {
              color: 'rgba(255, 255, 255, 0.6)',
              callback: function(value) { return value + '%'; }
            }
          },
          x: {
            grid: {
              display: false
            },
            ticks: {
              color: 'rgba(255, 255, 255, 0.6)'
            }
          }
        },
        plugins: {
          legend: {
            display: false
          }
        }
      },
      plugins: [{
        id: 'targetLine',
        afterDraw: (chart) => {
          const chartCtx = chart.ctx;
          const yAxis = chart.scales.y;
          const xAxis = chart.scales.x;
          const yVal = yAxis.getPixelForValue(80);
          
          chartCtx.save();
          chartCtx.beginPath();
          chartCtx.strokeStyle = '#4caf50';
          chartCtx.lineWidth = 2;
          chartCtx.setLineDash([6, 6]);
          chartCtx.moveTo(xAxis.left, yVal);
          chartCtx.lineTo(xAxis.right, yVal);
          chartCtx.stroke();
          
          chartCtx.fillStyle = '#4caf50';
          chartCtx.font = 'bold 12px sans-serif';
          chartCtx.fillText('Target (80%)', xAxis.right - 85, yVal - 5);
          chartCtx.restore();
        }
      }]
    });
  }

  // Bind sub-tabs inside Fee Analytics (Class-wise, School-wise, Detailed Report)
  document.querySelectorAll('#fee-panel-fee-analytics .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const container = btn.closest('.fee-option-panel');
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const targetTab = btn.getAttribute('data-tab');
      container.querySelectorAll('.tab-content').forEach(content => {
        if (content.id === `tab-${targetTab}`) {
          content.style.display = 'block';
        } else {
          content.style.display = 'none';
        }
      });
    });
  });

  // Re-bind Transaction Logs filters & list under Detailed Report Analytics
  const btnLoadLedgerLogs = document.getElementById('btn-load-ledger-logs');
  if (btnLoadLedgerLogs) {
    btnLoadLedgerLogs.addEventListener('click', async () => {
      const cls = document.getElementById('ledger-filter-class').value;
      const month = document.getElementById('analytics-filter-month').value; // Sync with analytics month
      const status = document.getElementById('ledger-filter-status').value;

      let endpoint = '/fees/ledger?';
      if (cls && cls !== 'All Classes') endpoint += `class_name=${encodeURIComponent(cls)}&`;
      if (month) endpoint += `month=${month}&`;
      if (status) endpoint += `status=${status}&`;

      try {
        const list = await apiCall(endpoint);
        const tbody = document.querySelector('#table-ledger-logs tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (list.length === 0) {
          tbody.innerHTML = '<tr><td colspan="11" style="text-align: center;">No ledger details found.</td></tr>';
          return;
        }

        list.forEach(l => {
          let badge = 'status-unpaid';
          if (l.status === 'Paid') badge = 'status-present';
          else if (l.status === 'Partial') badge = 'status-partial';

          tbody.innerHTML += `
            <tr>
              <td>${l.roll_no || '-'}</td>
              <td><strong>${l.student_name}</strong></td>
              <td>${l.class_name}</td>
              <td>${l.month} ${l.year}</td>
              <td>${l.previous_due.toLocaleString()} Rs</td>
              <td>${l.monthly_fee.toLocaleString()} Rs</td>
              <td>${l.transport_fee.toLocaleString()} Rs</td>
              <td><strong>${l.total_payable.toLocaleString()} Rs</strong></td>
              <td><span style="color:var(--accent); font-weight:700;">${l.paid_amount.toLocaleString()} Rs</span></td>
              <td>${(l.total_payable - l.paid_amount).toLocaleString()} Rs</td>
              <td><span class="status-badge ${badge}">${l.status}</span></td>
            </tr>
          `;
        });
      } catch (e) {}
    });
  }


  // ==========================================
  // MODULE: FEE SLIP
  // ==========================================

  const slipStudentsCache = [];

  const btnSearchSlipStudent = document.getElementById('btn-search-slip-student');
  if (btnSearchSlipStudent) {
    btnSearchSlipStudent.addEventListener('click', async () => {
      const search = document.getElementById('slip-search').value.trim();
      if (!search) return;

      try {
        const students = await apiCall(`/students?search=${encodeURIComponent(search)}`);
        slipStudentsCache.length = 0;
        const tbody = document.querySelector('#table-slip-students tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (students.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No students found.</td></tr>';
          return;
        }

        students.forEach(s => {
          slipStudentsCache.push(s);
          tbody.innerHTML += `
            <tr>
              <td>${s.roll_no || 'N/A'}</td>
              <td><strong>${s.name}</strong></td>
              <td>${s.class_name} ${s.section_name ? '(' + s.section_name + ')' : ''}</td>
              <td>${s.father_name || '-'}</td>
              <td><button class="btn btn-primary btn-sm btn-generate-slip" data-id="${s.id}">Generate Slip</button></td>
            </tr>
          `;
        });

        document.querySelectorAll('.btn-generate-slip').forEach(btn => {
          btn.addEventListener('click', () => {
            const studentId = btn.getAttribute('data-id');
            generateSlipsForStudents([slipStudentsCache.find(s => s.id == studentId)]);
          });
        });
      } catch (e) {}
    });
  }

  function buildSlipHTML(studentData, schoolData, year) {
    const allMonths = ['Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb'];
    const d = studentData;

    // Only include months that have actual ledger data (not null)
    const activeMonths = allMonths.filter(m => d.monthlyFee[m] !== null && d.monthlyFee[m] !== undefined);

    if (activeMonths.length === 0) {
      return `
        <div class="fee-slip">
          <div class="slip-header">
            <img src="/${schoolData.logo || 'school_assets/school_logo.png'}" class="slip-logo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect width=%2236%22 height=%2236%22 fill=%22%236366f1%22/><text x=%2218%22 y=%2224%22 font-size=%2216%22 fill=%22white%22 text-anchor=%22middle%22>SS</text></svg>'">
            <div class="slip-header-text">
              <h2>${schoolData.name || 'School Name'}</h2>
              <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
            </div>
          </div>
          <div class="slip-student-row">
            <div class="slip-student-info">
              <div><strong>Name:</strong> ${d.student.name}</div>
              <div><strong>F-Name:</strong> ${d.student.father_name || '-'}</div>
              <div><strong>Class:</strong> ${d.student.class_name}${d.student.section_name ? ' (' + d.student.section_name + ')' : ''}</div>
            </div>
            <div class="slip-student-info">
              <div><strong>Roll No:</strong> ${d.student.roll_no || '-'}</div>
              <div><strong>ID:</strong> ${d.student.admission_no || d.student.id}</div>
            </div>
            <div class="slip-badge">FEE SLIP ${year}-${parseInt(year)+1}</div>
          </div>
          <div style="text-align: center; padding: 20px; color: #666;">No fee ledger data found for this year.</div>
        </div>
      `;
    }

    let tableRows = '';
    const rows = [
      { label: 'Mnth Fee', data: d.monthlyFee },
      { label: 'Transport', data: d.transportFee },
      { label: 'Due', data: d.due },
      { label: 'Total', data: d.total },
      { label: 'Paid', data: d.paid },
      { label: 'Unpaid', data: d.unpaid }
    ];

    rows.forEach(row => {
      let tr = `<tr><td>${row.label}</td>`;
      activeMonths.forEach(m => {
        const val = row.data[m];
        tr += `<td>${val !== null && val !== undefined ? val.toLocaleString() : '-'}</td>`;
      });
      tr += '</tr>';
      tableRows += tr;
    });

    return `
      <div class="fee-slip">
        <div class="slip-header">
          <img src="/${schoolData.logo || 'school_assets/school_logo.png'}" class="slip-logo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect width=%2236%22 height=%2236%22 fill=%22%236366f1%22/><text x=%2218%22 y=%2224%22 font-size=%2216%22 fill=%22white%22 text-anchor=%22middle%22>SS</text></svg>'">
          <div class="slip-header-text">
            <h2>${schoolData.name || 'School Name'}</h2>
            <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
          </div>
        </div>
        <div class="slip-student-row">
          <div class="slip-student-info">
            <div><strong>Name:</strong> ${d.student.name}</div>
            <div><strong>F-Name:</strong> ${d.student.father_name || '-'}</div>
            <div><strong>Class:</strong> ${d.student.class_name}${d.student.section_name ? ' (' + d.student.section_name + ')' : ''}</div>
          </div>
          <div class="slip-student-info">
            <div><strong>Roll No:</strong> ${d.student.roll_no || '-'}</div>
            <div><strong>ID:</strong> ${d.student.admission_no || d.student.id}</div>
          </div>
          <div class="slip-badge">FEE SLIP ${year}-${parseInt(year)+1}</div>
        </div>
        <div class="table-container" style="border: 2px solid #000; background: #fff;">
          <table class="data-table" style="color: #000;">
            <thead>
              <tr style="background: #f0f0f0;">
                <th></th>
                ${activeMonths.map(m => `<th>${m}</th>`).join('')}
              </tr>
            </thead>
            <tbody style="color: #000;">${tableRows}</tbody>
          </table>
        </div>
        <div class="slip-footer">
          <div class="slip-sign">Principal Sign: _______________</div>
          <div class="slip-net-total">NET TOTAL: ${d.netTotal.toLocaleString()}</div>
        </div>
      </div>
    `;
  }

  async function generateSlipsForStudents(students) {
    const year = document.getElementById('slip-year').value;
    const a4Page = document.getElementById('slip-a4-page');
    a4Page.innerHTML = '';

    try {
      const allData = await Promise.all(
        students.map(s => apiCall(`/fees/slip/${s.id}?year=${year}`))
      );

      allData.forEach(data => {
        a4Page.innerHTML += buildSlipHTML(data, data.school, year);
      });

      document.getElementById('slip-student-list-container').style.display = 'none';
      document.getElementById('slip-preview-container').style.display = 'block';
    } catch (e) {
      showToast('Failed to load fee slips: ' + (e.message || 'Unknown error'), true);
    }
  }

  const btnPrintFeeSlip = document.getElementById('btn-print-fee-slip');
  if (btnPrintFeeSlip) {
    btnPrintFeeSlip.addEventListener('click', () => {
      const a4Page = document.getElementById('slip-a4-page');
      const printHTML = a4Page.innerHTML;
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <html><head><title>Fee Slips</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: Arial, sans-serif; }
          @page { size: A4; margin: 10mm; }
          .a4-page {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px;
            padding: 5mm;
            page-break-after: always;
          }
          .fee-slip { border: 2px solid #000; padding: 6px; color: #000; font-size: 0.65rem; break-inside: avoid; }
          .slip-header { display: flex; align-items: center; gap: 6px; border-bottom: 2px solid #000; padding-bottom: 4px; margin-bottom: 4px; }
          .slip-logo { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
          .slip-header-text h2 { font-size: 0.6rem; font-weight: 800; margin: 0; text-transform: uppercase; }
          .slip-header-text p { font-size: 0.5rem; margin: 1px 0 0; }
          .slip-student-row { display: flex; justify-content: space-between; gap: 6px; margin-bottom: 4px; padding: 4px; border: 1px solid #ccc; border-radius: 2px; }
          .slip-student-info { font-size: 0.55rem; line-height: 1.4; }
          .slip-student-info strong { display: inline-block; min-width: 35px; }
          .slip-badge { background: #000; color: #fff; padding: 3px 6px; font-weight: 700; font-size: 0.5rem; white-space: nowrap; }
          table { width: 100%; border-collapse: collapse; border: 1px solid #000; }
          th, td { padding: 2px 3px; font-size: 0.5rem; border: 1px solid #ccc; text-align: center; }
          th { background: #f5f5f5; font-weight: 700; }
          td:first-child { text-align: left; font-weight: 600; background: #f9f9f9; font-size: 0.48rem; }
          .slip-footer { display: flex; justify-content: space-between; align-items: center; margin-top: 4px; padding-top: 3px; border-top: 2px solid #000; }
          .slip-sign { font-size: 0.5rem; }
          .slip-net-total { background: #000; color: #fff; padding: 2px 8px; font-weight: 800; font-size: 0.55rem; }
        </style></head><body><div class="a4-page">${printHTML}</div></body></html>
      `);
      printWindow.document.close();
      printWindow.print();
    });
  }

  const btnBackSlipList = document.getElementById('btn-back-slip-list');
  if (btnBackSlipList) {
    btnBackSlipList.addEventListener('click', () => {
      document.getElementById('slip-student-list-container').style.display = 'block';
      document.getElementById('slip-preview-container').style.display = 'none';
    });
  }


  // ==========================================
  // MODULE: EXAMS, MARKS & RESULT CARDS
  // ==========================================

  // Exam Dashboard: reset to show dashboard view
  function resetExamPanels() {
    const dash = document.getElementById('exam-dashboard-view');
    if (dash) dash.style.display = 'block';
    document.querySelectorAll('.exam-option-panel').forEach(panel => {
      panel.style.display = 'none';
    });
  }

  // Dashboard card clicks to show target panel
  document.querySelectorAll('#screen-exams .fees-dash-card').forEach(card => {
    card.addEventListener('click', () => {
      const targetOpt = card.getAttribute('data-opt');
      const dash = document.getElementById('exam-dashboard-view');
      if (dash) dash.style.display = 'none';
      document.querySelectorAll('.exam-option-panel').forEach(p => p.style.display = 'none');
      
      const targetPanel = document.getElementById(`exam-panel-${targetOpt}`);
      if (targetPanel) {
        targetPanel.style.display = 'block';
        loadExamPanelData(targetOpt);
      }
    });
  });

  // Back button clicks in exam option panels
  document.querySelectorAll('.btn-back-exam-dash').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      resetExamPanels();
    });
  });

  // Load data for specific exam option panel
  function loadExamPanelData(opt) {
    loadClassesList();
    loadExamsDropdowns();
    loadExamSetupYears();
    loadExamClassCheckboxes();

    if (opt === 'exam-datesheet') {
      loadDatesheetDesignData();
    } else if (opt === 'exam-rollno') {
      loadRollnoDesignData();
    }
  }

  // Populate year dropdown for Create Exam (from current year to +5 years)
  function loadExamSetupYears() {
    const yearSel = document.getElementById('exam-create-year');
    if (!yearSel) return;
    const currentYear = new Date().getFullYear();
    yearSel.innerHTML = '';
    for (let y = currentYear; y <= currentYear + 5; y++) {
      yearSel.innerHTML += `<option value="${y}">${y}</option>`;
    }
  }

  // Populate class checkboxes for exam creation (All Classes + each class)
  async function loadExamClassCheckboxes() {
    const container = document.getElementById('exam-class-checkboxes');
    if (!container) return;
    try {
      const classes = await apiCall('/students/classes');
      container.innerHTML = `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:5px 10px; border-radius:6px; background:rgba(255,255,255,0.05);">
          <input type="checkbox" id="exam-class-all" value="All Classes"> <span>All Classes</span>
        </label>
      `;
      classes.forEach(cls => {
        container.innerHTML += `
          <label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:5px 10px; border-radius:6px; background:rgba(255,255,255,0.05);">
            <input type="checkbox" class="exam-class-check" value="${cls}"> <span>${cls}</span>
          </label>
        `;
      });
      document.getElementById('exam-class-all').addEventListener('change', (e) => {
        document.querySelectorAll('.exam-class-check').forEach(cb => cb.checked = e.target.checked);
      });
    } catch (e) {}
  }

  function loadExamsData() {
    resetExamPanels();
    loadClassesList();
    loadExamsDropdowns();
  }

  // Load exams into select dropdown inputs (including new datesheet/rollno selects)
  async function loadExamsDropdowns() {
    try {
      const exams = await apiCall('/exams');
      const marksSelectExam = document.getElementById('marks-select-exam');
      const calcExamSelect = document.getElementById('calc-exam-select');
      const dmcSelectExam = document.getElementById('dmc-select-exam');
      const datesheetExamSelect = document.getElementById('datesheet-exam-select');
      const rollnoExamSelect = document.getElementById('rollno-exam-select');
      const rollnoGenExam = document.getElementById('rollno-gen-exam');

      const selectors = [marksSelectExam, calcExamSelect, dmcSelectExam, datesheetExamSelect, rollnoExamSelect, rollnoGenExam];

      // Deduplicate exams by id
      const seen = new Set();
      const uniqueExams = exams.filter(ex => {
        if (seen.has(ex.id)) return false;
        seen.add(ex.id);
        return true;
      });

      selectors.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '';
        uniqueExams.forEach(ex => {
          sel.innerHTML += `<option value="${ex.id}">${ex.exam_name} (${ex.year})</option>`;
        });
        if (currentVal) sel.value = currentVal;
      });

    } catch (e) {}
  }

  // Create exam registry
  document.getElementById('form-create-exam').addEventListener('submit', async (e) => {
    e.preventDefault();
    const exam_name = document.getElementById('exam-create-name').value;
    const year = document.getElementById('exam-create-year').value;

    // Get selected classes
    const allCb = document.getElementById('exam-class-all');
    const classCbs = document.querySelectorAll('.exam-class-check');
    let selectedClasses = [];
    if (allCb && allCb.checked) {
      try { selectedClasses = await apiCall('/students/classes'); } catch (e) { selectedClasses = []; }
    } else {
      classCbs.forEach(cb => { if (cb.checked) selectedClasses.push(cb.value); });
    }

    if (selectedClasses.length === 0) {
      showToast('Please select at least one class', true);
      return;
    }

    try {
      const res = await apiCall('/exams', 'POST', { exam_name, year, classes: selectedClasses });
      showToast(res.message);
      loadExamsDropdowns();
      if (allCb) allCb.checked = false;
      classCbs.forEach(cb => cb.checked = false);
    } catch (err) {}
  });

  // Marks Spreadsheet loader - fetches all subjects for class
  document.getElementById('btn-load-marks-grid').addEventListener('click', async () => {
    const exam_id = document.getElementById('marks-select-exam').value;
    const class_name = document.getElementById('marks-select-class').value;
    const section_name = document.getElementById('marks-select-sec').value;
    const term = document.getElementById('marks-select-term').value;

    if (!exam_id || !class_name) {
      showToast('Exam and Class are required', true);
      return;
    }

    try {
      const data = await apiCall(`/exams/marks/spreadsheet?exam_id=${exam_id}&class_name=${encodeURIComponent(class_name)}&term=${encodeURIComponent(term)}&section_name=${encodeURIComponent(section_name || '')}`);
      const subjects = data.subjects || [];
      const grid = data.grid || [];

      const thead = document.getElementById('marks-grid-head');
      const tbody = document.querySelector('#table-marks-grid tbody');
      tbody.innerHTML = '';

      const infoBox = document.getElementById('marks-subject-info');
      if (subjects.length === 0) {
        infoBox.style.display = 'block';
        infoBox.innerHTML = '<strong>No subjects found.</strong> Add subjects to the Timetable for this class, or set up subjects in "Exam Setup".';
        thead.innerHTML = '<tr><th>Roll No</th><th>Student Name</th><th>Class / Section</th></tr>';
        document.getElementById('marks-grid-actions').style.display = 'none';
        return;
      }

      infoBox.style.display = 'block';
      infoBox.innerHTML = '<strong>' + subjects.length + ' subject(s) from timetable:</strong> ' + subjects.map(s => s.subject + ' (Max: ' + s.max_marks + ')').join(', ');

      let headerHtml = '<tr><th style="position:sticky;left:0;background:var(--bg-secondary);z-index:1;">Roll No</th><th style="position:sticky;left:80px;background:var(--bg-secondary);z-index:1;">Student Name</th><th>Class / Section</th>';
      subjects.forEach(sub => {
        headerHtml += '<th style="min-width:90px;">' + sub.subject + '<br><span style="font-size:0.7rem;font-weight:400;color:var(--text-muted);">(Max: ' + sub.max_marks + ')</span></th>';
      });
      headerHtml += '</tr>';
      thead.innerHTML = headerHtml;

      if (grid.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align: center;">No students found in this class</td></tr>';
        document.getElementById('marks-grid-actions').style.display = 'none';
        return;
      }

      grid.forEach(s => {
        let rowHtml = '<tr data-student-id="' + s.id + '">';
        rowHtml += '<td style="position:sticky;left:0;background:var(--bg-primary);z-index:1;"><strong>' + (s.roll_no || '-') + '</strong></td>';
        rowHtml += '<td style="position:sticky;left:80px;background:var(--bg-primary);z-index:1;"><strong>' + s.name + '</strong></td>';
        rowHtml += '<td>' + s.class_name + ' - ' + (s.section_name || 'N/A') + '</td>';
        subjects.forEach(sub => {
          const val = s.marks[sub.subject] !== undefined ? s.marks[sub.subject] : '';
          rowHtml += '<td><input type="number" class="marks-input marks-cell" data-subject="' + sub.subject + '" data-max="' + sub.max_marks + '" value="' + val + '" min="0" max="' + sub.max_marks + '" placeholder="0"></td>';
        });
        rowHtml += '</tr>';
        tbody.innerHTML += rowHtml;
      });

      document.getElementById('marks-grid-actions').style.display = 'block';
    } catch (e) {
      showToast('Failed to load marks spreadsheet', true);
    }
  });

  // Save Marks Spreadsheet - all subjects at once
  document.getElementById('btn-save-marks').addEventListener('click', async () => {
    const exam_id = document.getElementById('marks-select-exam').value;
    const term = document.getElementById('marks-select-term').value;

    if (!exam_id || !term) {
      showToast('Exam and Term are required', true);
      return;
    }

    const rows = document.querySelectorAll('#table-marks-grid tbody tr[data-student-id]');
    const marksData = [];

    rows.forEach(row => {
      const student_id = parseInt(row.getAttribute('data-student-id'));
      const marks = {};
      row.querySelectorAll('.marks-cell').forEach(cell => {
        const subject = cell.getAttribute('data-subject');
        const val = cell.value;
        marks[subject] = val === '' ? null : parseInt(val);
      });
      marksData.push({ student_id, marks });
    });

    if (marksData.length === 0) {
      showToast('No student rows to save', true);
      return;
    }

    try {
      const res = await apiCall('/exams/marks/spreadsheet', 'POST', { exam_id, term, marksData });
      showToast(res.message);
    } catch (err) {
      showToast('Failed to save marks', true);
    }
  });

  // Execute Result calculator
  document.getElementById('form-result-calculate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = document.getElementById('calc-feedback');
    feedback.innerText = 'Calculating dense positions and percentages... Please wait.';
    feedback.style.display = 'block';

    const exam_id = document.getElementById('calc-exam-select').value;
    const class_name = document.getElementById('calc-class-select').value;
    const section_name = document.getElementById('calc-sec-select').value;
    const term = document.getElementById('calc-term-select').value;

    try {
      const body = { exam_id, class_name, term };
      if (section_name) body.section_name = section_name;

      const res = await apiCall('/exams/calculate', 'POST', body);
      feedback.innerText = res.message;
      showToast(res.message);
      loadDashboardStats();
    } catch (err) {
      feedback.innerText = 'Calculation failed: ' + err.message;
    }
  });

  // DMC Portal - Class filter, section filter, load students, and search

  // Populate class filter for DMC
  async function loadDmcClassFilter() {
    try {
      const classes = await apiCall('/students/classes');
      const sel = document.getElementById('dmc-filter-class');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- All Classes --</option>';
      classes.forEach(c => { sel.innerHTML += `<option value="${c}">${c}</option>`; });
    } catch (e) {}
  }
  loadDmcClassFilter();

  // Section filter for DMC
  document.getElementById('dmc-filter-class').addEventListener('change', async function() {
    const cls = this.value;
    const secSel = document.getElementById('dmc-filter-section');
    secSel.innerHTML = '<option value="">-- All Sections --</option>';
    if (!cls) return;
    try {
      const sections = await apiCall(`/students/sections/${encodeURIComponent(cls)}`);
      sections.forEach(s => { secSel.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`; });
    } catch (e) {}
  });

  // Load students button
  document.getElementById('btn-dmc-load-students').addEventListener('click', () => loadDmcStudents());

  async function loadDmcStudents() {
    const cls = document.getElementById('dmc-filter-class').value;
    const sec = document.getElementById('dmc-filter-section').value;
    const search = document.getElementById('dmc-student-search').value.trim();

    let url = '/students?';
    if (cls) url += `class_name=${encodeURIComponent(cls)}&`;
    if (sec && sec !== 'All Sections') url += `section_name=${encodeURIComponent(sec)}&`;
    if (search) url += `search=${encodeURIComponent(search)}&`;

    try {
      const list = await apiCall(url);
      renderDmcStudents(list);
    } catch (e) { showToast('Failed to load students', true); }
  }

  function renderDmcStudents(list) {
    const dmcStudentsTable = document.querySelector('#table-dmc-students tbody');
    dmcStudentsTable.innerHTML = '';

    if (list.length === 0) {
      dmcStudentsTable.innerHTML = '<tr><td colspan="3" style="text-align: center;">No students found</td></tr>';
      return;
    }

    list.forEach(s => {
      dmcStudentsTable.innerHTML += `
        <tr class="clickable-row select-dmc-stud-row" data-id="${s.id}" style="cursor:pointer;">
          <td><strong>${s.roll_no || '-'}</strong></td>
          <td>${s.name}</td>
          <td>${s.class_name} - ${s.section_name || 'N/A'}</td>
        </tr>
      `;
    });

    document.querySelectorAll('.select-dmc-stud-row').forEach(row => {
      row.addEventListener('click', () => {
        document.querySelectorAll('.select-dmc-stud-row').forEach(r => r.style.background = 'none');
        row.style.background = 'rgba(99, 102, 241, 0.15)';
        activeStudentDmcId = row.getAttribute('data-id');
        document.getElementById('dmc-fallback-msg').style.display = 'none';
      });
    });
  }

  // Text search also works with class filter
  document.getElementById('dmc-student-search').addEventListener('input', () => {
    loadDmcStudents();
  });

  // Load detailed DMC report card (single student or whole class)
  document.getElementById('btn-load-dmc-report').addEventListener('click', async () => {
    const exam_id = document.getElementById('dmc-select-exam').value;
    const term = document.getElementById('dmc-select-term').value;
    const cls = document.getElementById('dmc-filter-class').value;
    const sec = document.getElementById('dmc-filter-section').value;

    if (!exam_id || !term) {
      showToast('Select exam and term first', true);
      return;
    }

    try {
      // If a specific student is selected, show single DMC
      if (activeStudentDmcId) {
        const res = await apiCall(`/exams/dmc/${activeStudentDmcId}?exam_id=${exam_id}&term=${encodeURIComponent(term)}`);
        renderSingleDmc(res);
        return;
      }

      // If a class is selected, show ALL students' DMCs
      if (cls) {
        let url = `/exams/dmc/class/${encodeURIComponent(cls)}?exam_id=${exam_id}&term=${encodeURIComponent(term)}`;
        if (sec && sec !== 'All Sections') url += `&section_name=${encodeURIComponent(sec)}`;
        const allDmcs = await apiCall(url);
        renderClassDmcs(allDmcs, cls, sec);
        return;
      }

      showToast('Select a class or search and select a student first', true);
    } catch (err) {
      showToast('Failed to load result card: ' + err.message, true);
    }
  });

  function renderSingleDmc(res) {
    const examEl = document.getElementById('dmc-select-exam');
    const examText = examEl.options[examEl.selectedIndex] ? examEl.options[examEl.selectedIndex].text : '';
    const term = document.getElementById('dmc-select-term').value;
    const s = res.student;
    const sum = res.summary;
    const details = res.reportDetails || [];
    const photoUrl = s.photo ? '/' + s.photo : '';

    let totalMax = 0, totalObt = 0;
    details.forEach(r => { totalMax += r.max_marks; totalObt += r.obtained_marks; });

    apiCall('/settings').then(set => {
      const schoolLogo = set.logo_path ? '/' + set.logo_path : 'school_assets/school_logo.png';
      const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const posLabel = sum.position && sum.position !== '-' ? sum.position : '-';

      const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111; padding: 30px; background: white;">
          <div style="text-align: center; margin-bottom: 20px;">
            <img src="${schoolLogo}" style="width: 70px; height: 70px; border-radius: 50%; object-fit: cover; margin-bottom: 8px;" onerror="this.style.display='none'">
            <h1 style="margin: 0; font-size: 1.5rem; font-weight: 900; text-transform: uppercase; letter-spacing: 1px;">${currentUser.schoolName}</h1>
            <div style="border-top: 2px solid #111; margin: 12px 0;"></div>
            <h2 style="margin: 0; font-size: 1.1rem; font-weight: 700; text-transform: uppercase;">DETAILED MARKS CERTIFICATE</h2>
            <p style="margin: 5px 0 0; font-size: 0.95rem; color: #333;">${term} Examination ${new Date().getFullYear()}</p>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; font-size: 0.95rem;">
            <div style="flex: 1;">
              <p style="margin: 4px 0;"><strong>Name:</strong> ${s.name}</p>
              <p style="margin: 4px 0;"><strong>Father Name:</strong> ${s.father_name || '-'}</p>
              <p style="margin: 4px 0;"><strong>Roll No:</strong> ${s.roll_no || '-'}</p>
              <p style="margin: 4px 0;"><strong>Class:</strong> ${s.class_name} ${s.section_name ? '- ' + s.section_name : ''}</p>
            </div>
            <div style="text-align: right; flex-shrink: 0; margin-left: 20px;">
              ${photoUrl ? `<img src="${photoUrl}" style="width: 80px; height: 100px; border: 1px solid #ccc; object-fit: cover;">` : '<div style="width: 80px; height: 100px; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: #999;">No Photo</div>'}
            </div>
          </div>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.9rem;">
            <thead>
              <tr style="background: #f0f0f0;">
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 6%;">No</th>
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: left;">Subject</th>
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 18%;">Total Marks</th>
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 18%;">Obtained Marks</th>
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 25%;">Remarks</th>
              </tr>
            </thead>
            <tbody>
              ${details.map((r, i) => `<tr>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${i + 1}</td>
                <td style="border: 1px solid #111; padding: 8px 10px;">${r.subject}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.max_marks}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.obtained_marks}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${i === 0 ? (sum.remarks || '') : ''}</td>
              </tr>`).join('')}
              <tr style="font-weight: 700; background: #f9f9f9;">
                <td style="border: 1px solid #111; padding: 8px 10px;" colspan="2">Total</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${totalMax}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${totalObt}</td>
                <td style="border: 1px solid #111; padding: 8px 10px;"></td>
              </tr>
            </tbody>
          </table>

          <div style="display: flex; gap: 0; margin-bottom: 25px; border: 2px solid #111; border-radius: 6px; overflow: hidden;">
            <div style="flex: 1; padding: 14px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
              <div style="font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Percentage</div>
              <div style="font-size: 1.5rem; font-weight: 900; color: #111; margin-top: 4px;">${sum.percentage}%</div>
            </div>
            <div style="flex: 1; padding: 14px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
              <div style="font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Class Position</div>
              <div style="font-size: 1.5rem; font-weight: 900; color: #111; margin-top: 4px;">${posLabel}</div>
            </div>
            <div style="flex: 1; padding: 14px 10px; text-align: center; background: #f9f9f9;">
              <div style="font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Grade</div>
              <div style="font-size: 1.5rem; font-weight: 900; color: #111; margin-top: 4px;">${sum.grade}</div>
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 0.85rem; color: #333;">
            <div style="text-align: center;">
              <p style="margin-bottom: 35px;">Signatures of:</p>
              <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Teacher incharge</div>
            </div>
            <div style="text-align: center;">
              <p style="margin-bottom: 35px;"></p>
              <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Parent</div>
            </div>
            <div style="text-align: center;">
              <p style="margin-bottom: 35px;"></p>
              <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Principal</div>
            </div>
          </div>

          <div style="border-top: 1px solid #ccc; padding-top: 10px; font-size: 0.78rem; color: #555;">
            <p style="margin: 2px 0;">Result Declaration Date: ${today}</p>
            <p style="margin: 2px 0;">Note: Error and omission can be accepted within three days. This result is computer generated by SkyHonix Digital.</p>
            <p style="margin: 2px 0;">Contact: ${set.phone || 'N/A'}</p>
          </div>
        </div>`;

      document.getElementById('dmc-printable-sheet').innerHTML = html;
      document.getElementById('dmc-printable-sheet').style.display = 'block';
      document.getElementById('btn-print-dmc').style.display = 'block';
    });
  }

  function renderClassDmcs(allDmcs, cls, sec) {
    const container = document.getElementById('dmc-printable-sheet');
    const examEl = document.getElementById('dmc-select-exam');
    const examText = examEl.options[examEl.selectedIndex] ? examEl.options[examEl.selectedIndex].text : '';
    const term = document.getElementById('dmc-select-term').value;

    apiCall('/settings').then(set => {
      const schoolLogo = set.logo_path ? '/' + set.logo_path : 'school_assets/school_logo.png';
      const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      let html = '';

      allDmcs.forEach((dmc, idx) => {
        const s = dmc.student;
        const sum = dmc.summary;
        const details = dmc.reportDetails || [];
        const photoUrl = s.photo ? '/' + s.photo : '';
        let totalMax = 0, totalObt = 0;
        details.forEach(r => { totalMax += r.max_marks; totalObt += r.obtained_marks; });
        const posLabel = sum.position && sum.position !== '-' ? sum.position : '-';

        if (idx > 0) html += '<div style="page-break-after: always; break-after: page;"></div>';

        html += `
          <div style="font-family: Arial, Helvetica, sans-serif; color: #111; padding: 30px; background: white;">
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="${schoolLogo}" style="width: 70px; height: 70px; border-radius: 50%; object-fit: cover; margin-bottom: 8px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 1.5rem; font-weight: 900; text-transform: uppercase; letter-spacing: 1px;">${currentUser.schoolName}</h1>
              <div style="border-top: 2px solid #111; margin: 12px 0;"></div>
              <h2 style="margin: 0; font-size: 1.1rem; font-weight: 700; text-transform: uppercase;">DETAILED MARKS CERTIFICATE</h2>
              <p style="margin: 5px 0 0; font-size: 0.95rem; color: #333;">${term} Examination ${new Date().getFullYear()}</p>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; font-size: 0.95rem;">
              <div style="flex: 1;">
                <p style="margin: 4px 0;"><strong>Name:</strong> ${s.name}</p>
                <p style="margin: 4px 0;"><strong>Father Name:</strong> ${s.father_name || '-'}</p>
                <p style="margin: 4px 0;"><strong>Roll No:</strong> ${s.roll_no || '-'}</p>
                <p style="margin: 4px 0;"><strong>Class:</strong> ${s.class_name} ${s.section_name ? '- ' + s.section_name : ''}</p>
              </div>
              <div style="text-align: right; flex-shrink: 0; margin-left: 20px;">
                ${photoUrl ? `<img src="${photoUrl}" style="width: 80px; height: 100px; border: 1px solid #ccc; object-fit: cover;">` : '<div style="width: 80px; height: 100px; border: 1px solid #ccc; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; color: #999;">No Photo</div>'}
              </div>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.9rem;">
              <thead>
                <tr style="background: #f0f0f0;">
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 6%;">No</th>
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: left;">Subject</th>
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 18%;">Total Marks</th>
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 18%;">Obtained Marks</th>
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 25%;">Remarks</th>
                </tr>
              </thead>
              <tbody>
                ${details.map((r, i) => `<tr>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${i + 1}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px;">${r.subject}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.max_marks}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.obtained_marks}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${i === 0 ? (sum.remarks || '') : ''}</td>
                </tr>`).join('')}
                <tr style="font-weight: 700; background: #f9f9f9;">
                  <td style="border: 1px solid #111; padding: 8px 10px;" colspan="2">Total</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${totalMax}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${totalObt}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px;"></td>
                </tr>
              </tbody>
            </table>

            <div style="display: flex; gap: 0; margin-bottom: 25px; border: 2px solid #111; border-radius: 6px; overflow: hidden;">
              <div style="flex: 1; padding: 14px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
                <div style="font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Percentage</div>
                <div style="font-size: 1.5rem; font-weight: 900; color: #111; margin-top: 4px;">${sum.percentage}%</div>
              </div>
              <div style="flex: 1; padding: 14px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
                <div style="font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Class Position</div>
                <div style="font-size: 1.5rem; font-weight: 900; color: #111; margin-top: 4px;">${posLabel}</div>
              </div>
              <div style="flex: 1; padding: 14px 10px; text-align: center; background: #f9f9f9;">
                <div style="font-size: 0.7rem; color: #666; text-transform: uppercase; letter-spacing: 0.5px;">Grade</div>
                <div style="font-size: 1.5rem; font-weight: 900; color: #111; margin-top: 4px;">${sum.grade}</div>
              </div>
            </div>

            <div style="display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 0.85rem; color: #333;">
              <div style="text-align: center;">
                <p style="margin-bottom: 35px;">Signatures of:</p>
                <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Teacher incharge</div>
              </div>
              <div style="text-align: center;">
                <p style="margin-bottom: 35px;"></p>
                <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Parent</div>
              </div>
              <div style="text-align: center;">
                <p style="margin-bottom: 35px;"></p>
                <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Principal</div>
              </div>
            </div>

            <div style="border-top: 1px solid #ccc; padding-top: 10px; font-size: 0.78rem; color: #555;">
              <p style="margin: 2px 0;">Result Declaration Date: ${today}</p>
              <p style="margin: 2px 0;">Note: Error and omission can be accepted within three days. This result is computer generated by SkyHonix Digital.</p>
              <p style="margin: 2px 0;">Contact: ${set.phone || 'N/A'}</p>
            </div>
          </div>`;
      });

      container.innerHTML = html;
      container.style.display = 'block';
      document.getElementById('btn-print-dmc').style.display = 'block';
      showToast(`${allDmcs.length} result card(s) loaded`);
    });
  }

  // Print DMC Sheet Trigger
  document.getElementById('btn-print-dmc').addEventListener('click', () => {
    const sheetContent = document.getElementById('dmc-printable-sheet').innerHTML;

    document.body.innerHTML = `
      <style>
        @page { margin: 0; size: A4; }
        @media print {
          body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          html { margin: 0; padding: 0; }
        }
      </style>
      <div style="padding:40px; background:white; color:black; font-family:sans-serif; min-height:100vh;">
        ${sheetContent}
      </div>
    `;
    window.print();
    window.location.reload();
  });

  // ==========================================
  // DATE SHEET PANEL LOGIC
  // ==========================================
  let datesheetRowCount = 0;

  function loadDatesheetDesignData() {
    // Reset rows
    const container = document.getElementById('datesheet-rows-container');
    if (container) {
      container.innerHTML = '';
      datesheetRowCount = 0;
    }
    // Load saved templates into generate tab dropdown
    loadDatesheetTemplates();
  }

  // Load saved date sheet templates into the generate tab dropdown (deduplicated by name)
  async function loadDatesheetTemplates() {
    const sel = document.getElementById('datesheet-gen-template');
    if (!sel) return;
    try {
      const templates = await apiCall('/exams/datesheets');
      // Deduplicate by name — keep latest (highest id) for each unique name
      const uniqueMap = {};
      templates.forEach(t => {
        const key = t.name;
        if (!uniqueMap[key] || t.id > uniqueMap[key].id) {
          uniqueMap[key] = t;
        }
      });
      const unique = Object.values(uniqueMap).sort((a, b) => b.id - a.id);
      sel.innerHTML = '<option value="">-- Select Template --</option>';
      unique.forEach(t => {
        const activeMark = t.is_active ? ' [ACTIVE]' : '';
        const style = t.is_active ? ' style="font-weight:bold;color:#16a34a;"' : '';
        sel.innerHTML += '<option value="' + t.id + '"' + style + '>' + t.name + activeMark + '</option>';
      });
      updateDatesheetActiveBadge(templates);
    } catch (e) {}
  }

  // Show template info when selected
  document.getElementById('datesheet-gen-template').addEventListener('change', async function() {
    const templateId = this.value;
    const infoDiv = document.getElementById('datesheet-template-info');
    const previewDiv = document.getElementById('datesheet-preview');
    if (!templateId) { infoDiv.style.display = 'none'; previewDiv.style.display = 'none'; return; }

    try {
      const templates = await apiCall('/exams/datesheets');
      const tpl = templates.find(t => t.id == templateId);
      if (!tpl) return;

      const t = tpl.template;
      const subjects = t.subjects || [];
      const classGroups = {};
      subjects.forEach(s => {
        const cls = s.class || 'All Classes';
        if (!classGroups[cls]) classGroups[cls] = [];
        classGroups[cls].push(s);
      });

      const classNames = Object.keys(classGroups);
      const subjectNames = [...new Set(subjects.map(s => s.subject))];

      infoDiv.style.display = 'block';
      infoDiv.innerHTML = '<strong>Template:</strong> ' + tpl.name +
        ' &mdash; <strong>' + subjects.length + ' exam entries</strong> across ' +
        '<strong>' + classNames.length + ' class(es)</strong>: ' + classNames.join(', ') +
        '<br><strong>Subjects:</strong> ' + subjectNames.join(', ');
    } catch (e) {}
  });

  function updateDatesheetActiveBadge(templates) {
    const badge = document.getElementById('datesheet-active-badge');
    if (!badge) return;
    const active = (templates || []).find(t => t.is_active);
    if (active) {
      badge.style.display = 'block';
      badge.innerHTML = '<strong>Active Datesheet:</strong> ' + active.name;
    } else {
      badge.style.display = 'none';
      badge.innerHTML = '';
    }
  }

  // Add subject row for date sheet designer (with class selector)
  const btnAddDatesheetRow = document.getElementById('btn-add-datesheet-row');
  if (btnAddDatesheetRow) {
    btnAddDatesheetRow.addEventListener('click', () => {
      datesheetRowCount++;
      const container = document.getElementById('datesheet-rows-container');
      // Build class options from cached classes
      let classOpts = '<option value="All Classes">All Classes</option>';
      if (typeof cachedClasses !== 'undefined' && cachedClasses.length > 0) {
        cachedClasses.forEach(cls => { classOpts += `<option value="${cls}">${cls}</option>`; });
      }
      const rowHtml = `
        <div style="display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr auto; gap: 10px; margin-bottom: 10px; align-items: flex-end;" id="datesheet-row-${datesheetRowCount}">
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Subject</label>
            <input type="text" class="form-control" placeholder="e.g. Mathematics" required>
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Class</label>
            <select class="form-control ds-row-class" required>${classOpts}</select>
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Date</label>
            <input type="date" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Time</label>
            <input type="text" class="form-control" placeholder="e.g. 9:00 AM - 12:00 PM" required>
          </div>
          <button type="button" class="btn btn-danger btn-sm btn-remove-datesheet-row" style="margin-bottom: 2px;">&times;</button>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', rowHtml);
    });

    // Remove row handler (event delegation)
    document.getElementById('datesheet-rows-container').addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-remove-datesheet-row')) {
        e.target.closest('[id^="datesheet-row-"]').remove();
      }
    });
  }

  // Save date sheet template
  const formDatesheetDesign = document.getElementById('form-datesheet-design');
  if (formDatesheetDesign) {
    formDatesheetDesign.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('datesheet-template-name').value.trim();
      const exam_id = document.getElementById('datesheet-exam-select').value;
      const term = document.getElementById('datesheet-term-select').value;

      const rows = document.querySelectorAll('#datesheet-rows-container [id^="datesheet-row-"]');
      if (rows.length === 0) {
        showToast('Please add at least one subject row', true);
        return;
      }

      const subjects = [];
      rows.forEach(row => {
        const subjectInput = row.querySelector('input[type="text"]');
        const classSelect = row.querySelector('.ds-row-class');
        const dateInput = row.querySelector('input[type="date"]');
        subjects.push({
          subject: subjectInput.value,
          class: classSelect.value,
          date: dateInput.value,
          time: row.querySelectorAll('input[type="text"]')[1].value
        });
      });

      const template = { exam_id, term, subjects };
      
      try {
        const res = await apiCall('/exams/datesheets', 'POST', { name, template_json: JSON.stringify(template) });
        showToast(res.message);
        formDatesheetDesign.reset();
        document.getElementById('datesheet-rows-container').innerHTML = '';
        datesheetRowCount = 0;
        loadDatesheetTemplates();
      } catch (err) {}
    });
  }

  // Load date sheet for preview/print
  const btnLoadDatesheet = document.getElementById('btn-load-datesheet');
  if (btnLoadDatesheet) {
    btnLoadDatesheet.addEventListener('click', async () => {
      const templateId = document.getElementById('datesheet-gen-template').value;
      if (!templateId) {
        showToast('Please select a template', true);
        return;
      }

      try {
        const templates = await apiCall('/exams/datesheets');
        const tpl = templates.find(t => t.id == templateId);
        if (!tpl) { showToast('Template not found', true); return; }

        const t = tpl.template;
        const exams = await apiCall('/exams');
        const exam = exams.find(ex => ex.id == t.exam_id);

        let settings = {};
        try { settings = await apiCall('/settings'); } catch (e) {}
        const logoUrl = settings.logo_path ? '/' + settings.logo_path : 'school_assets/school_logo.png';

        const subjects = t.subjects || [];

        // Build matrix: collect unique dates and classes
        const dateSet = new Set();
        const classSet = new Set();
        const cellMap = {}; // cellMap[class][date] = subject

        subjects.forEach(s => {
          const cls = s.class || 'All Classes';
          const date = s.date || '';
          classSet.add(cls);
          if (date) dateSet.add(date);
          if (!cellMap[cls]) cellMap[cls] = {};
          cellMap[cls][date] = s.subject || '-';
        });

        const sortedDates = Array.from(dateSet).sort();
        const sortedClasses = Array.from(classSet).sort((a, b) => {
          const na = parseInt(a), nb = parseInt(b);
          if (!isNaN(na) && !isNaN(nb)) return na - nb;
          return a.localeCompare(b);
        });

        // Header row: Paper Date | Date1 | Date2 | ...
        let headerCells = '<th style="border:2px solid #000; padding:8px 10px; text-align:left; font-weight:700; background:#f0f0f0; min-width:100px;">Paper Date</th>';
        sortedDates.forEach(d => {
          const dateObj = new Date(d + 'T00:00:00');
          const formatted = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
          headerCells += '<th style="border:2px solid #000; padding:8px 10px; text-align:center; font-weight:700; background:#f0f0f0; min-width:110px;">' + formatted + '</th>';
        });

        // Body rows: one per class
        let bodyRows = '';
        sortedClasses.forEach((cls, idx) => {
          const bg = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';
          let cells = '<td style="border:2px solid #000; padding:8px 10px; font-weight:700; background:' + bg + ';">' + cls + '</td>';
          sortedDates.forEach(d => {
            const subject = (cellMap[cls] && cellMap[cls][d]) ? cellMap[cls][d] : '';
            cells += '<td style="border:2px solid #000; padding:8px 10px; text-align:center; background:' + bg + ';">' + subject + '</td>';
          });
          bodyRows += '<tr>' + cells + '</tr>';
        });

        document.getElementById('datesheet-printable-content').innerHTML =
          '<div style="text-align:center; margin-bottom:30px;">' +
            '<div style="display:flex; align-items:center; justify-content:center; gap:20px; margin-bottom:15px;">' +
              '<img src="' + logoUrl + '" alt="School Logo" style="max-height:80px; max-width:120px; border-radius:8px;" onerror="this.style.display=\'none\'">' +
              '<div>' +
                '<h1 style="margin:0; font-size:2.2rem; color:#1e293b; font-weight:800; letter-spacing:0.5px;">' + currentUser.schoolName + '</h1>' +
              '</div>' +
            '</div>' +
            '<div style="border-top:3px solid #1e293b; margin:15px auto; width:60%;"></div>' +
            '<p style="margin:8px 0; color:#333; font-size:1rem;">' +
              '<strong>Exam:</strong> ' + (exam ? exam.exam_name + ' ' + exam.year : '-') +
              ' &nbsp;&nbsp;|&nbsp;&nbsp; <strong>Term:</strong> ' + (t.term || '-') +
            '</p>' +
          '</div>' +
          '<table style="width:100%; border-collapse:collapse; margin-top:15px; font-size:0.95rem;">' +
            '<thead><tr>' + headerCells + '</tr></thead>' +
            '<tbody>' + bodyRows + '</tbody>' +
          '</table>' +
          '<div style="margin-top:40px; padding-top:15px; font-size:0.85rem; color:#333;">' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-end;">' +
              '<div>' +
                '<p style="margin:0 0 4px 0;">&#8226; All students must be uniformed.</p>' +
                '<p style="margin:0;">&#8226; Students must come on time.</p>' +
              '</div>' +
              '<div style="text-align:right;">' +
                '<p style="margin:0 0 30px 0;">Principal Sign: ____________________</p>' +
                '<p style="margin:0; font-weight:700; font-size:1rem;">' + currentUser.schoolName + '</p>' +
              '</div>' +
            '</div>' +
          '</div>';
        document.getElementById('datesheet-preview').style.display = 'block';
      } catch (err) {}
    });
  }

  const btnPrintDatesheet = document.getElementById('btn-print-datesheet');
  if (btnPrintDatesheet) {
    btnPrintDatesheet.addEventListener('click', () => {
      const content = document.getElementById('datesheet-printable-content').innerHTML;
      document.body.innerHTML = '<div style="padding:40px; background:white; color:black; font-family:sans-serif; min-height:100vh;">' + content + '</div>';
      window.print();
      window.location.reload();
    });
  }

  // Activate datesheet template
  const btnActivateDatesheet = document.getElementById('btn-activate-datesheet');
  if (btnActivateDatesheet) {
    btnActivateDatesheet.addEventListener('click', async () => {
      const templateId = document.getElementById('datesheet-gen-template').value;
      if (!templateId) {
        showToast('Please select a template to activate', true);
        return;
      }
      try {
        const res = await apiCall('/exams/datesheets/' + templateId + '/activate', 'PUT');
        showToast(res.message);
        loadDatesheetTemplates();
      } catch (err) {
        showToast('Failed to activate datesheet', true);
      }
    });
  }

  // Delete datesheet template
  const btnDeleteDatesheet = document.getElementById('btn-delete-datesheet');
  if (btnDeleteDatesheet) {
    btnDeleteDatesheet.addEventListener('click', async () => {
      const templateId = document.getElementById('datesheet-gen-template').value;
      if (!templateId) { showToast('Select a template to delete', true); return; }
      if (!confirm('Delete this datesheet template?')) return;
      try {
        await apiCall('/exams/datesheets/' + templateId, 'DELETE');
        showToast('Template deleted');
        document.getElementById('datesheet-preview').style.display = 'none';
        document.getElementById('datesheet-template-info').style.display = 'none';
        loadDatesheetTemplates();
      } catch (err) { showToast(err.message, true); }
    });
  }

  // Preview datesheet template from designer (live preview)
  const btnPreviewDatesheet = document.getElementById('btn-preview-datesheet-template');
  if (btnPreviewDatesheet) {
    btnPreviewDatesheet.addEventListener('click', () => {
      const rows = document.querySelectorAll('#datesheet-rows-container [id^="datesheet-row-"]');
      if (rows.length === 0) { showToast('Add at least one subject row first', true); return; }

      const subjects = [];
      rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        const classSelect = row.querySelector('.ds-row-class');
        subjects.push({
          subject: inputs[0].value || '(unnamed)',
          class: classSelect.value,
          date: inputs[1].value,
          time: inputs[2].value
        });
      });

      // Build matrix
      const dateSet = new Set();
      const classSet = new Set();
      const cellMap = {};
      subjects.forEach(s => {
        const cls = s.class || 'All Classes';
        const date = s.date || '';
        classSet.add(cls);
        if (date) dateSet.add(date);
        if (!cellMap[cls]) cellMap[cls] = {};
        cellMap[cls][date] = s.subject || '-';
      });
      const sortedDates = Array.from(dateSet).sort();
      const sortedClasses = Array.from(classSet).sort((a, b) => {
        const na = parseInt(a), nb = parseInt(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        return a.localeCompare(b);
      });

      let headerCells = '<th style="border:2px solid #000; padding:8px 10px; text-align:left; font-weight:700; background:#f0f0f0;">Paper Date</th>';
      sortedDates.forEach(d => {
        const dateObj = new Date(d + 'T00:00:00');
        const formatted = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
        headerCells += '<th style="border:2px solid #000; padding:8px 10px; text-align:center; font-weight:700; background:#f0f0f0;">' + formatted + '</th>';
      });
      let bodyRows = '';
      sortedClasses.forEach((cls, idx) => {
        const bg = idx % 2 === 0 ? '#ffffff' : '#f9f9f9';
        let cells = '<td style="border:2px solid #000; padding:8px 10px; font-weight:700; background:' + bg + ';">' + cls + '</td>';
        sortedDates.forEach(d => {
          const subject = (cellMap[cls] && cellMap[cls][d]) ? cellMap[cls][d] : '';
          cells += '<td style="border:2px solid #000; padding:8px 10px; text-align:center; background:' + bg + ';">' + subject + '</td>';
        });
        bodyRows += '<tr>' + cells + '</tr>';
      });

      const classNames = Object.keys(classSet);
      document.getElementById('datesheet-design-preview-content').innerHTML =
        '<div style="text-align:center; margin-bottom:20px;">' +
          '<h3 style="color:#1e293b; margin:0;">Template Preview</h3>' +
          '<p style="color:#64748b; font-size:0.9rem;">' + subjects.length + ' exam entries across ' + classNames.length + ' class(es): ' + classNames.join(', ') + '</p>' +
        '</div>' +
        '<table style="width:100%; border-collapse:collapse; font-size:0.9rem;">' +
          '<thead><tr>' + headerCells + '</tr></thead>' +
          '<tbody>' + bodyRows + '</tbody>' +
        '</table>';
      document.getElementById('datesheet-design-preview').style.display = 'block';
    });
  }

  // ==========================================
  // ROLL NO SLIP PANEL LOGIC
  // ==========================================
  function loadRollnoDesignData() {
    // Dropdowns already populated
  }

  // Save roll no slip template
  const formRollnoDesign = document.getElementById('form-rollno-design');
  if (formRollnoDesign) {
    formRollnoDesign.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('rollno-template-name').value.trim();
      const exam_id = document.getElementById('rollno-exam-select').value;
      const class_name = document.getElementById('rollno-class-select').value;
      const term = document.getElementById('rollno-term-select').value;
      const include_logo = document.getElementById('rollno-include-logo').value;
      const include_qr = document.getElementById('rollno-include-qr').value;
      const per_page = document.getElementById('rollno-per-page').value;
      const signFile = document.getElementById('rollno-principal-sign').files[0];

      // Collect selected predefined instructions + custom text
      const checkedInst = [];
      document.querySelectorAll('.rollno-inst-check:checked').forEach(cb => checkedInst.push(cb.value));
      const customInst = document.getElementById('rollno-instructions').value.trim();
      if (customInst) checkedInst.push(customInst);
      const instructions = checkedInst.join('. ') + (checkedInst.length > 0 ? '.' : '');

      let principal_sign = '';
      if (signFile) {
        principal_sign = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = (ev) => resolve(ev.target.result);
          reader.readAsDataURL(signFile);
        });
      }

      const template = { exam_id, class_name, term, include_logo, include_qr, per_page, instructions, principal_sign };

      try {
        const res = await apiCall('/exams/rollno-templates', 'POST', { name, template_json: JSON.stringify(template) });
        showToast(res.message);
        formRollnoDesign.reset();
      } catch (err) {}
    });
  }

  // Generate roll no slips
  const btnGenerateRollno = document.getElementById('btn-generate-rollno-slips');
  if (btnGenerateRollno) {
    btnGenerateRollno.addEventListener('click', async () => {
      const class_name = document.getElementById('rollno-gen-class').value;
      const exam_id = document.getElementById('rollno-gen-exam').value;

      if (!exam_id) {
        showToast('Exam is required', true);
        return;
      }

      try {
        let students = [];
        if (class_name === 'All Classes') {
          students = await apiCall('/students');
        } else {
          students = await apiCall(`/students?class_name=${encodeURIComponent(class_name)}`);
        }
        const exam = (await apiCall('/exams')).find(e => e.id == exam_id);

        let settings = {};
        try { settings = await apiCall('/settings'); } catch (e) {}
        const logoUrl = settings.logo_path ? '/' + settings.logo_path : 'school_assets/school_logo.png';

        let activeDatesheet = null;
        try { activeDatesheet = await apiCall('/exams/datesheets/active'); } catch (e) {}

        let principal_sign = null;
        try {
          const rollnoTemplates = await apiCall('/exams/rollno-templates');
          if (rollnoTemplates.length > 0) {
            principal_sign = rollnoTemplates[0].template.principal_sign || null;
          }
        } catch (e) {}

        if (students.length === 0) {
          showToast('No students found', true);
          return;
        }

        let slipsHtml = '';
        students.forEach((s, idx) => {
          let subjectsForClass = [];
          if (activeDatesheet && activeDatesheet.template && activeDatesheet.template.subjects) {
            subjectsForClass = activeDatesheet.template.subjects.filter(sub => {
              return sub.class === 'All Classes' || sub.class === s.class_name;
            });
          }

          let tableRows = '';
          if (subjectsForClass.length > 0) {
            subjectsForClass.forEach((sub, i) => {
              const dateObj = sub.date ? new Date(sub.date + 'T00:00:00') : null;
              const dayName = dateObj ? dateObj.toLocaleDateString('en-US', { weekday: 'long' }) : '-';
              const dateFormatted = dateObj ? dateObj.toLocaleDateString('en-US', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '-';
              tableRows += '<tr>' +
                '<td style="border:1px solid #333; padding:5px 6px; text-align:center;">' + (i + 1) + '</td>' +
                '<td style="border:1px solid #333; padding:5px 6px; text-align:center;">' + dateFormatted + '</td>' +
                '<td style="border:1px solid #333; padding:5px 6px; text-align:center; font-weight:600;">' + dayName + '</td>' +
                '<td style="border:1px solid #333; padding:5px 6px; font-weight:500;">' + sub.subject + '</td>' +
                '<td style="border:1px solid #333; padding:5px 6px; text-align:center;">' + (sub.time || '-') + '</td>' +
                '</tr>';
            });
          } else {
            tableRows = '<tr><td colspan="5" style="border:1px solid #333; padding:12px; text-align:center; color:#888;">No datesheet subjects available for this class</td></tr>';
          }

          const instructions = [
            'All Students Must be Uniformed.',
            'Students Must come on time.',
            'Dues Must be cleared.'
          ];
          let instHtml = instructions.map(inst => '<li style="margin:3px 0;">' + inst + '</li>').join('');

          const studentPhoto = s.photo ? '/' + s.photo : '';

          slipsHtml += '<div class="rollno-slip">' +
            '<div style="text-align:center; margin-bottom:3px;">' +
              '<h1 style="margin:0; font-size:1.2rem; font-weight:800; color:#1e293b; text-transform:uppercase; letter-spacing:1px;">' + currentUser.schoolName + '</h1>' +
            '</div>' +
            '<div style="display:flex; align-items:center; justify-content:center; margin:5px 0 8px;">' +
              '<img src="' + logoUrl + '" alt="School Logo" style="max-height:50px; max-width:70px; border-radius:50%;" onerror="this.style.display=\'none\'">' +
            '</div>' +
            '<div style="text-align:center; margin-bottom:10px;">' +
              '<h2 style="margin:0; font-size:0.95rem; font-weight:700; letter-spacing:1px;">ROLL NO SLIP</h2>' +
              '<p style="margin:3px 0 0; font-size:0.8rem; color:#444;">' + (exam ? exam.exam_name + ' Exam ' + exam.year : '') + '</p>' +
            '</div>' +
            '<div style="display:flex; gap:12px; align-items:center; margin-bottom:10px; padding:8px; border:1px solid #ddd; border-radius:6px; background:#fafafa;">' +
              (studentPhoto ?
                '<img src="' + studentPhoto + '" alt="Photo" style="width:60px; height:75px; border-radius:4px; object-fit:cover; border:1px solid #ccc;" onerror="this.style.display=\'none\'">' :
                '<div style="width:60px; height:75px; border-radius:4px; border:1px solid #ccc; background:#e2e8f0; display:flex; align-items:center; justify-content:center; font-size:1.5rem; color:#94a3b8;">👤</div>'
              ) +
              '<div style="flex:1; font-size:0.8rem; display:grid; grid-template-columns:1fr 1fr; gap:3px 10px;">' +
                '<div><strong>Name:</strong>&nbsp;' + (s.name || '-') + '</div>' +
                '<div><strong>Roll No:</strong>&nbsp;' + (s.roll_no || '-') + '</div>' +
                '<div><strong>Class:</strong>&nbsp;' + (s.class_name || '-') + (s.section_name ? ' - ' + s.section_name : '') + '</div>' +
                '<div><strong>Father:</strong>&nbsp;' + (s.father_name || '-') + '</div>' +
              '</div>' +
            '</div>' +
            '<table style="width:100%; border-collapse:collapse; margin-bottom:10px; font-size:0.75rem;">' +
              '<thead>' +
                '<tr style="background:#f0f0f0;">' +
                  '<th style="border:1px solid #333; padding:5px 6px; text-align:center; width:6%;">#</th>' +
                  '<th style="border:1px solid #333; padding:5px 6px; text-align:center; width:22%;">Date</th>' +
                  '<th style="border:1px solid #333; padding:5px 6px; text-align:center; width:20%;">Day</th>' +
                  '<th style="border:1px solid #333; padding:5px 6px; text-align:left; width:30%;">Subject</th>' +
                  '<th style="border:1px solid #333; padding:5px 6px; text-align:center; width:22%;">Time</th>' +
                '</tr>' +
              '</thead>' +
              '<tbody>' + tableRows + '</tbody>' +
            '</table>' +
            '<div style="display:flex; justify-content:space-between; align-items:flex-end; font-size:0.75rem;">' +
              '<div style="max-width:55%;">' +
                '<p style="margin:0 0 3px; font-weight:600;">Instructions:</p>' +
                '<ul style="margin:0; padding-left:15px;">' + instHtml + '</ul>' +
              '</div>' +
              (principal_sign ?
                '<div style="text-align:center;">' +
                  '<img src="' + principal_sign + '" alt="Principal Sign" style="max-height:30px; max-width:60px; opacity:0.7; margin-bottom:2px;">' +
                  '<div style="border-top:1px solid #333; width:100px; margin:0 auto; padding-top:3px; font-size:0.7rem; color:#555;">Principal Signature</div>' +
                '</div>'
              :
                '<div style="text-align:center;">' +
                  '<div style="height:30px;"></div>' +
                  '<div style="border-top:1px solid #333; width:100px; margin:0 auto; padding-top:3px; font-size:0.7rem; color:#555;">Principal Signature</div>' +
                '</div>'
              ) +
            '</div>' +
          '</div>';
        });

        document.getElementById('rollno-printable-content').innerHTML = slipsHtml;
        document.getElementById('rollno-preview').style.display = 'block';
      } catch (err) {}
    });
  }

  const btnPrintRollno = document.getElementById('btn-print-rollno');
  if (btnPrintRollno) {
    btnPrintRollno.addEventListener('click', () => {
      const content = document.getElementById('rollno-printable-content').innerHTML;
      document.body.innerHTML =
        '<style>' +
          '@page { size: A4 landscape; margin: 8mm; }' +
          '@media print { ' +
            'body { margin: 0; padding: 0; }' +
            'div.rollno-slip { page-break-inside: avoid; break-inside: avoid; width: 48%; display: inline-block; vertical-align: top; box-sizing: border-box; margin: 0; padding: 12px; border: 2px solid #333; font-family: sans-serif; font-size: 0.78rem; }' +
            'div.rollno-slip:nth-child(odd) { margin-right: 2%; }' +
            'div.rollno-slip h1 { font-size: 1.2rem; }' +
            'div.rollno-slip h2 { font-size: 0.95rem; }' +
            'div.rollno-slip table { font-size: 0.75rem; }' +
            'div.rollno-slip table th, div.rollno-slip table td { padding: 5px 6px; }' +
            'div.rollno-slip img { max-height: 50px; max-width: 70px; }' +
            'div.rollno-slip img[alt="Photo"] { max-height: 75px; max-width: 60px; }' +
          '}' +
        '</style>' +
        '<div style="padding:5px; background:white; color:black;">' + content + '</div>';
      window.print();
      window.location.reload();
    });
  }


  // ==========================================
  // MODULE: PORTAL SETTINGS
  // ==========================================
  async function loadSettingsData() {
    try {
      const data = await apiCall('/settings');
      document.getElementById('set-school-name').value = data.school_name;
      document.getElementById('set-footer-text').value = data.footer_text;
      document.getElementById('set-phone').value = data.phone;
      document.getElementById('set-reg').value = data.registration_number;
    } catch (e) {}
  }

  // Update profile settings
  document.getElementById('form-settings-school').addEventListener('submit', async (e) => {
    e.preventDefault();
    const school_name = document.getElementById('set-school-name').value.trim();
    const footer_text = document.getElementById('set-footer-text').value.trim();
    const phone = document.getElementById('set-phone').value.trim();
    const registration_number = document.getElementById('set-reg').value.trim();

    try {
      const res = await apiCall('/settings', 'POST', { school_name, phone, registration_number, footer_text });
      showToast(res.message);
      
      // Update school header name
      headerSchoolName.innerText = school_name;
      currentUser.schoolName = school_name;
      localStorage.setItem('skyhonix_user', JSON.stringify(currentUser));
      loadDashboardStats();
    } catch (err) {}
  });

  // Logo upload
  document.getElementById('form-settings-logo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('set-logo-input');
    if (!fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('logo', fileInput.files[0]);

    try {
      const res = await apiCall('/settings/logo', 'POST', formData, true);
      showToast(res.message);
      loadDashboardStats();
    } catch (err) {}
  });

  // Change staff password
  document.getElementById('form-settings-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const role = document.getElementById('set-pass-role').value;
    const password = document.getElementById('set-pass-val').value;

    if (password.length < 6) {
      showToast('Password must be at least 6 characters long', true);
      return;
    }

    try {
      const res = await apiCall('/settings/users/password', 'POST', { role, password });
      showToast(res.message);
      document.getElementById('set-pass-val').value = '';
    } catch (err) {}
  });

  // Database Backup download
  document.getElementById('btn-settings-backup').addEventListener('click', async () => {
    try {
      showToast('Preparing backup download...');
      const response = await fetch('/api/settings/backup', {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Backup failed');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition');
      let filename = 'school_backup.db';
      if (disposition) {
        const match = disposition.match(/filename="?([^"]+)"?/);
        if (match) filename = match[1];
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Backup downloaded successfully!');
    } catch (err) {
      showToast('Backup failed: ' + err.message, true);
    }
  });

  // Database Restore upload
  document.getElementById('form-settings-restore').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fileInput = document.getElementById('restore-db-file');
    if (!fileInput.files[0]) return;

    if (!confirm('WARNING: Uploading a database backup will OVERRIDE all current online records. Do you wish to proceed?')) {
      return;
    }

    const feedback = document.getElementById('restore-feedback');
    feedback.innerText = 'Uploading and restoring database file... Please do not close browser.';
    feedback.style.display = 'block';

    const formData = new FormData();
    formData.append('backup', fileInput.files[0]);

    try {
      const res = await apiCall('/settings/restore', 'POST', formData, true);
      feedback.innerText = `${res.message} (School Name verified: ${res.schoolName})`;
      showToast(res.message);
      
      // Auto reload after 2s
      setTimeout(() => {
        window.location.reload();
      }, 2000);
      
    } catch (err) {
      feedback.innerText = 'Database restoration failed: ' + err.message;
    }
  });

  // Delete All School Data
  document.getElementById('form-settings-delete-all').addEventListener('submit', async (e) => {
    e.preventDefault();
    const confirmInput = document.getElementById('delete-confirm-input');
    const feedback = document.getElementById('delete-feedback');

    if (confirmInput.value !== 'DELETE ALL DATA') {
      feedback.style.display = 'block';
      feedback.style.color = '#ff5252';
      feedback.innerText = 'Please type "DELETE ALL DATA" exactly as shown.';
      return;
    }

    if (!confirm('FINAL WARNING: This will permanently delete ALL students, fees, attendance, exams, marks, and results. This cannot be undone. Continue?')) {
      return;
    }

    feedback.style.display = 'block';
    feedback.style.color = 'var(--accent)';
    feedback.innerText = 'Deleting all school data...';

    try {
      const res = await apiCall('/settings/delete-all-data', 'POST', { confirm_text: 'DELETE ALL DATA' });
      feedback.style.color = '#4caf50';
      feedback.innerText = res.message;
      showToast(res.message);
      confirmInput.value = '';
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      feedback.style.color = '#ff5252';
      feedback.innerText = 'Failed to delete data: ' + err.message;
    }
  });

  // Backup Before Delete button (same backup, triggered from danger zone)
  const btnDeleteZoneBackup = document.getElementById('btn-delete-zone-backup');
  if (btnDeleteZoneBackup) {
    btnDeleteZoneBackup.addEventListener('click', async () => {
      try {
        showToast('Preparing backup download...');
        const response = await fetch('/api/settings/backup', {
          headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Backup failed');
        }

        const blob = await response.blob();
        const disposition = response.headers.get('Content-Disposition');
        let filename = 'school_backup_before_delete.db';
        if (disposition) {
          const match = disposition.match(/filename="?([^"]+)"?/);
          if (match) filename = match[1];
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Backup downloaded! Now safe to delete.');
      } catch (err) {
        showToast('Backup failed: ' + err.message, true);
      }
    });
  }


  // ==========================================
  // MODULE: BILLING, SUBSCRIPTION, & MASTER ADMIN
  // ==========================================
  async function loadBillingData() {
    try {
      const data = await apiCall('/billing/status');
      
      // Update billing labels
      const statusText = document.getElementById('sub-status-text');
      statusText.innerText = data.school.subscription_status.toUpperCase();
      statusText.className = 'status-badge';
      
      if (data.school.subscription_status === 'active') {
        statusText.classList.add('status-present');
      } else if (data.school.subscription_status === 'trial') {
        statusText.classList.add('status-partial');
      } else {
        statusText.classList.add('status-absent');
      }

      document.getElementById('sub-due-text').innerText = data.school.next_due_date || 'N/A';

      // Render payment history
      const tbody = document.querySelector('#table-billing-slips tbody');
      tbody.innerHTML = '';

      if (data.paymentHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color:var(--text-muted);">No payment receipts uploaded.</td></tr>';
        return;
      }

      data.paymentHistory.forEach(slip => {
        let statusBadge = 'status-partial';
        if (slip.status === 'approved') statusBadge = 'status-present';
        else if (slip.status === 'rejected') statusBadge = 'status-absent';

        tbody.innerHTML += `
          <tr>
            <td>${slip.payment_date}</td>
            <td><strong>${slip.amount.toLocaleString()} PKR</strong></td>
            <td>${new Date(slip.submitted_at).toLocaleDateString()}</td>
            <td><a href="/${slip.receipt_photo}" target="_blank" style="color:var(--primary);">View Receipt Slip</a></td>
            <td><span class="status-badge ${statusBadge}">${slip.status.toUpperCase()}</span></td>
            <td>${slip.notes || '-'}</td>
          </tr>
        `;
      });

    } catch (e) {}
  }

  // Upload Payment receipt slip
  async function submitPaymentSlip(e, isLockScreen = false) {
    e.preventDefault();
    
    const amount = document.getElementById(isLockScreen ? 'lock-pay-amount' : 'bill-amount').value;
    const payment_date = document.getElementById(isLockScreen ? 'lock-pay-date' : 'bill-date').value;
    const fileInput = document.getElementById(isLockScreen ? 'lock-pay-receipt' : 'bill-receipt');
    const feedback = document.getElementById(isLockScreen ? 'lock-feedback' : 'toast-text');

    if (!fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('amount', amount);
    formData.append('payment_date', payment_date);
    formData.append('receipt', fileInput.files[0]);
    formData.append('notes', isLockScreen ? 'Submitted via Lock Overlay' : 'Standard Upload');

    try {
      const res = await apiCall('/billing/pay-slip', 'POST', formData, true);
      
      if (isLockScreen) {
        feedback.innerText = res.message;
        feedback.style.display = 'block';
        document.getElementById('form-lock-payment').reset();
      } else {
        showToast(res.message);
        document.getElementById('form-billing-upload').reset();
        loadBillingData();
      }
    } catch (err) {
      if (isLockScreen) {
        feedback.innerText = 'Failed: ' + err.message;
        feedback.style.display = 'block';
      }
    }
  }

  document.getElementById('form-billing-upload').addEventListener('submit', (e) => submitPaymentSlip(e, false));
  document.getElementById('form-lock-payment').addEventListener('submit', (e) => submitPaymentSlip(e, true));

  // --------------------------------------------------
  // Master Billing Admin verification panel rules
  // --------------------------------------------------
  const btnVerifyMasterPin = document.getElementById('btn-verify-master-pin');
  const masterPinInput = document.getElementById('master-pin-input');
  const masterAdminContent = document.getElementById('master-admin-content');
  
  const tabMasterSlips = document.getElementById('tab-master-slips');
  const tabMasterSchools = document.getElementById('tab-master-schools');
  const masterSlipsView = document.getElementById('master-slips-view');
  const masterSchoolsView = document.getElementById('master-schools-view');

  let activeMasterPin = '';

  // Tab switching logic
  if (tabMasterSlips && tabMasterSchools) {
    // Set initial styling for tabs
    tabMasterSlips.style.borderColor = 'var(--primary)';
    tabMasterSchools.style.borderColor = 'transparent';

    tabMasterSlips.addEventListener('click', () => {
      tabMasterSlips.style.borderColor = 'var(--primary)';
      tabMasterSchools.style.borderColor = 'transparent';
      masterSlipsView.style.display = 'block';
      masterSchoolsView.style.display = 'none';
      if (activeMasterPin) refreshMasterSlips(activeMasterPin);
    });

    tabMasterSchools.addEventListener('click', () => {
      tabMasterSchools.style.borderColor = 'var(--primary)';
      tabMasterSlips.style.borderColor = 'transparent';
      masterSlipsView.style.display = 'none';
      masterSchoolsView.style.display = 'block';
      if (activeMasterPin) refreshMasterSchools(activeMasterPin);
    });
  }

  btnVerifyMasterPin.addEventListener('click', async () => {
    const pin = masterPinInput.value.trim();
    if (!pin) return;

    try {
      // Perform initial slips fetch to verify pin
      const res = await fetch('/api/billing/admin/slips', {
        headers: { 'x-master-pin': pin }
      });
      const slips = await res.json();

      if (!res.ok) {
        throw new Error(slips.error || 'Failed master verification');
      }

      activeMasterPin = pin;
      showToast('Master admin verified! Access granted.');
      masterPinInput.value = '';
      masterAdminContent.style.display = 'block';

      // Load initial views
      loadMasterSlipsTable(slips, pin);
      refreshMasterSchools(pin);

    } catch (err) {
      showToast(err.message, true);
      masterAdminContent.style.display = 'none';
      activeMasterPin = '';
    }
  });

  async function refreshMasterSlips(pin) {
    try {
      const res = await fetch('/api/billing/admin/slips', { headers: { 'x-master-pin': pin } });
      const slips = await res.json();
      loadMasterSlipsTable(slips, pin);
    } catch (err) {
      console.error(err);
    }
  }

  async function refreshMasterSchools(pin) {
    try {
      const res = await fetch('/api/billing/admin/schools', { headers: { 'x-master-pin': pin } });
      const schools = await res.json();
      loadMasterSchoolsTable(schools, pin);
    } catch (err) {
      console.error(err);
    }
  }

  function loadMasterSlipsTable(slips, pin) {
    const tbody = document.querySelector('#table-master-slips tbody');
    tbody.innerHTML = '';

    if (slips.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color:var(--text-muted);">No billing logs uploaded yet.</td></tr>';
      return;
    }

    slips.forEach(slip => {
      const isPending = slip.status === 'pending';
      const actionButtons = isPending ? `
        <div style="display:flex; gap:8px;">
          <button class="btn btn-primary btn-sm btn-master-approve" data-id="${slip.id}">Approve</button>
          <button class="btn btn-danger btn-sm btn-master-reject" data-id="${slip.id}">Reject</button>
        </div>
      ` : `<span style="font-size:0.85rem; color:var(--text-muted);">Resolved</span>`;

      let badge = 'status-partial';
      if (slip.status === 'approved') badge = 'status-present';
      else if (slip.status === 'rejected') badge = 'status-absent';

      tbody.innerHTML += `
        <tr>
          <td>
            <strong>${slip.school_name}</strong>
            <div style="font-size:0.8rem; color:var(--text-muted);">Sys: ${slip.current_status.toUpperCase()}</div>
          </td>
          <td>${slip.email}</td>
          <td><strong>${slip.amount.toLocaleString()} PKR</strong></td>
          <td>${slip.payment_date}</td>
          <td><a href="/${slip.receipt_photo}" target="_blank" style="color:var(--primary);">View Attachment</a></td>
          <td><span class="status-badge ${badge}">${slip.status.toUpperCase()}</span></td>
          <td>${actionButtons}</td>
        </tr>
      `;
    });

    // Action Handlers
    document.querySelectorAll('.btn-master-approve').forEach(btn => {
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', () => processMasterSlipAction(btn.getAttribute('data-id'), 'approve', pin));
    });

    document.querySelectorAll('.btn-master-reject').forEach(btn => {
      btn.style.cursor = 'pointer';
      btn.addEventListener('click', () => {
        const notes = prompt('Reason for rejection:');
        if (notes !== null) {
          processMasterSlipAction(btn.getAttribute('data-id'), 'reject', pin, notes);
        }
      });
    });
  }

  function loadMasterSchoolsTable(schools, pin) {
    const tbody = document.querySelector('#table-master-schools tbody');
    tbody.innerHTML = '';

    if (schools.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color:var(--text-muted);">No schools registered yet.</td></tr>';
      return;
    }

    schools.forEach(school => {
      let badge = 'status-absent';
      if (school.subscription_status === 'active') badge = 'status-present';
      else if (school.subscription_status === 'trial') badge = 'status-partial';

      const expiry = school.next_due_date || 'N/A';

      tbody.innerHTML += `
        <tr>
          <td><code style="color: var(--accent); font-weight: 600;">${school.school_code || 'N/A'}</code></td>
          <td><strong>${school.school_name}</strong></td>
          <td>
            <div style="font-size:0.9rem;">${school.phone || 'N/A'}</div>
            <div style="font-size:0.8rem; color:var(--text-muted);">${school.email}</div>
          </td>
          <td><span class="status-badge ${badge}">${school.subscription_status.toUpperCase()}</span></td>
          <td><strong>${expiry}</strong></td>
          <td>
            <div style="display: flex; gap: 8px; align-items: center;">
              <select class="form-control select-months-${school.id}" style="width: 80px; display: inline-block; padding: 4px; font-size: 0.85rem; background: var(--bg-card); color: #fff; border: 1px solid rgba(255,255,255,0.1);">
                <option value="1">1 Month</option>
                <option value="2">2 Months</option>
                <option value="6">6 Months</option>
                <option value="12">12 Months</option>
              </select>
              <button class="btn btn-secondary btn-sm btn-allow-access" style="cursor: pointer;" data-school-id="${school.id}">Allow</button>
            </div>
          </td>
        </tr>
      `;
    });

    // Action Handlers for schools
    document.querySelectorAll('.btn-allow-access').forEach(btn => {
      btn.addEventListener('click', async () => {
        const schoolId = btn.getAttribute('data-school-id');
        const select = document.querySelector(`.select-months-${schoolId}`);
        const months = select ? select.value : '1';

        try {
          const response = await fetch('/api/billing/admin/allow', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-master-pin': pin
            },
            body: JSON.stringify({ school_id: schoolId, months: months })
          });

          const res = await response.json();
          if (!response.ok) throw new Error(res.error);

          showToast(res.message);
          refreshMasterSchools(pin);
          checkBillingStatus();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    });
  }

  async function processMasterSlipAction(slip_id, action, pin, notes = '') {
    try {
      const response = await fetch('/api/billing/admin/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-master-pin': pin
        },
        body: JSON.stringify({ slip_id, action, notes })
      });

      const res = await response.json();
      if (!response.ok) throw new Error(res.error);

      showToast(res.message);
      refreshMasterSlips(pin);
      checkBillingStatus();
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ==========================================
  // MODULE: STAFF MANAGEMENT (Teachers, Parents, Timetable)
  // ==========================================

  // -- Card click navigation for Admin Settings panels --
  document.querySelectorAll('[data-opt="manage-teachers"], [data-opt="manage-parents"], [data-opt="manage-timetable"], [data-opt="manage-announcements"]').forEach(card => {
    card.addEventListener('click', () => {
      const opt = card.getAttribute('data-opt');
      const adminScreen = document.getElementById('screen-admin-settings');
      adminScreen.querySelectorAll(':scope > .card, :scope > .grid-3').forEach(c => c.style.display = 'none');
      document.getElementById('panel-' + opt).style.display = 'block';
      if (opt === 'manage-teachers') loadTeachersList();
      if (opt === 'manage-parents') { loadParentsList(); }
      if (opt === 'manage-timetable') { populateTimetableDropdowns(); }
      if (opt === 'manage-announcements') { loadAnnouncementsList(); }
    });
  });

  document.querySelectorAll('.btn-back-settings').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = btn.closest('.fee-option-panel');
      if (panel) panel.style.display = 'none';
      const adminScreen = document.getElementById('screen-admin-settings');
      if (adminScreen) adminScreen.querySelectorAll(':scope > .card, :scope > .grid-3').forEach(c => c.style.display = '');
    });
  });

  // ==========================================
  // TEACHERS
  // ==========================================
  async function loadTeachersList() {
    try {
      const teachers = await apiCall('/staff/teachers');
      const tbody = document.querySelector('#table-teachers tbody');
      if (!tbody) return;
      if (teachers.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No teachers added yet.</td></tr>';
        return;
      }
      tbody.innerHTML = teachers.map(t => {
        // Build assignments display
        let assignmentsHtml = '<span style="color: var(--text-muted); font-size: 0.85rem;">Not assigned</span>';
        if (t.assignments && t.assignments.length > 0) {
          const grouped = {};
          t.assignments.forEach(a => {
            const key = `${a.class_name}${a.section_name ? ' - ' + a.section_name : ''}`;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(a.subject);
          });
          assignmentsHtml = Object.entries(grouped).map(([cls, subjects]) => {
            const uniqueSubjects = [...new Set(subjects)];
            return `<div style="margin-bottom:3px;"><strong style="color:var(--primary);">${cls}</strong> <span style="color:var(--text-muted);">— ${uniqueSubjects.join(', ')}</span></div>`;
          }).join('');
        }
        return `
        <tr>
          <td><strong>${t.name}</strong></td>
          <td>${t.phone}</td>
          <td>${t.subject || '-'}</td>
          <td>${assignmentsHtml}</td>
          <td><span class="badge ${t.status === 'Active' ? 'badge-green' : 'badge-red'}">${t.status}</span></td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-teacher" data-id="${t.id}" data-name="${t.name}" data-phone="${t.phone}" data-qualification="${t.qualification || ''}" data-status="${t.status}">Edit</button>
            <button class="btn btn-danger btn-sm btn-delete-teacher" data-id="${t.id}">Delete</button>
          </td>
        </tr>`;
      }).join('');

      tbody.querySelectorAll('.btn-edit-teacher').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('teacher-edit-id').value = btn.dataset.id;
          document.getElementById('teacher-name').value = btn.dataset.name;
          document.getElementById('teacher-phone').value = btn.dataset.phone;
          document.getElementById('teacher-qualification').value = btn.dataset.qualification;
          document.getElementById('teacher-password').value = '';
          document.getElementById('teacher-form-title').textContent = 'Edit Teacher';
          document.getElementById('btn-teacher-submit').textContent = 'Update Teacher';
          document.getElementById('btn-teacher-cancel').style.display = 'inline-block';
        });
      });

      tbody.querySelectorAll('.btn-delete-teacher').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this teacher?')) return;
          try {
            await apiCall(`/staff/teachers/${btn.dataset.id}`, 'DELETE');
            showToast('Teacher deleted');
            loadTeachersList();
          } catch (e) { showToast(e.message, true); }
        });
      });
    } catch (e) {}
  }

  document.getElementById('form-teacher').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('teacher-edit-id').value;
    const name = document.getElementById('teacher-name').value.trim();
    const phone = document.getElementById('teacher-phone').value.trim();
    const password = document.getElementById('teacher-password').value;
    const qualification = document.getElementById('teacher-qualification').value.trim();

    if (!name || !phone) return;
    if (!editId && !password) { showToast('Password is required for new teacher', true); return; }

    try {
      if (editId) {
        const body = { name, phone, qualification };
        if (password) body.password = password;
        await apiCall(`/staff/teachers/${editId}`, 'PUT', body);
        showToast('Teacher updated');
      } else {
        await apiCall('/staff/teachers', 'POST', { name, phone, password, qualification });
        showToast('Teacher added');
      }
      document.getElementById('form-teacher').reset();
      document.getElementById('teacher-edit-id').value = '';
      document.getElementById('teacher-form-title').textContent = 'Add New Teacher';
      document.getElementById('btn-teacher-submit').textContent = 'Add Teacher';
      document.getElementById('btn-teacher-cancel').style.display = 'none';
      loadTeachersList();
    } catch (err) { showToast(err.message, true); }
  });

  document.getElementById('btn-teacher-cancel').addEventListener('click', () => {
    document.getElementById('form-teacher').reset();
    document.getElementById('teacher-edit-id').value = '';
    document.getElementById('teacher-form-title').textContent = 'Add New Teacher';
    document.getElementById('btn-teacher-submit').textContent = 'Add Teacher';
    document.getElementById('btn-teacher-cancel').style.display = 'none';
  });

  // ==========================================
  // PARENTS
  // ==========================================
  async function loadParentsList() {
    try {
      const parents = await apiCall('/staff/parents');
      const tbody = document.querySelector('#table-parents tbody');
      if (!tbody) return;
      if (parents.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted);">No parent accounts created yet.</td></tr>';
        return;
      }
      tbody.innerHTML = parents.map(p => `
        <tr>
          <td><strong>${p.name}</strong></td>
          <td>${p.phone}</td>
          <td>${p.children || 'No children linked'}</td>
          <td><span class="badge ${p.status === 'Active' ? 'badge-green' : 'badge-red'}">${p.status}</span></td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-parent" data-id="${p.id}" data-name="${p.name}" data-phone="${p.phone}" data-status="${p.status}">Edit</button>
            <button class="btn btn-danger btn-sm btn-delete-parent" data-id="${p.id}">Delete</button>
          </td>
        </tr>
      `).join('');

      tbody.querySelectorAll('.btn-edit-parent').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('parent-edit-id').value = btn.dataset.id;
          document.getElementById('parent-phone').value = btn.dataset.phone;
          document.getElementById('parent-password').value = '';
          document.getElementById('parent-form-title').textContent = 'Edit Parent Account';
          document.getElementById('btn-parent-submit').textContent = 'Update Account';
          document.getElementById('btn-parent-cancel').style.display = 'inline-block';
        });
      });

      tbody.querySelectorAll('.btn-delete-parent').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this parent and all their links?')) return;
          try {
            await apiCall(`/staff/parents/${btn.dataset.id}`, 'DELETE');
            showToast('Parent deleted');
            loadParentsList();
          } catch (e) { showToast(e.message, true); }
        });
      });
    } catch (e) {}
  }

  document.getElementById('form-parent').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('parent-edit-id').value;
    const phone = document.getElementById('parent-phone').value.trim();
    const password = document.getElementById('parent-password').value;

    if (!phone) return;
    if (!editId && !password) { showToast('Password is required for new parent', true); return; }

    try {
      if (editId) {
        const body = { name: '', phone, status: 'Active' };
        if (password) body.password = password;
        await apiCall(`/staff/parents/${editId}`, 'PUT', body);
        showToast('Parent account updated');
      } else {
        await apiCall('/staff/parents', 'POST', { phone, password });
        showToast('Parent account created & students auto-linked');
      }
      document.getElementById('form-parent').reset();
      document.getElementById('parent-edit-id').value = '';
      document.getElementById('parent-form-title').textContent = 'Create Parent Account';
      document.getElementById('btn-parent-submit').textContent = 'Create Account';
      document.getElementById('btn-parent-cancel').style.display = 'none';
      loadParentsList();
    } catch (err) { showToast(err.message, true); }
  });

  document.getElementById('btn-parent-cancel').addEventListener('click', () => {
    document.getElementById('form-parent').reset();
    document.getElementById('parent-edit-id').value = '';
    document.getElementById('parent-form-title').textContent = 'Create Parent Account';
    document.getElementById('btn-parent-submit').textContent = 'Create Account';
    document.getElementById('btn-parent-cancel').style.display = 'none';
  });

  // ==========================================
  // TIMETABLE
  // ==========================================
  async function populateTimetableDropdowns() {
    try {
      const classes = await apiCall('/students/classes');
      const teachers = await apiCall('/staff/teachers');
      const ttClass = document.getElementById('tt-class');
      const ttTeacher = document.getElementById('tt-teacher');
      if (ttClass) {
        ttClass.innerHTML = '<option value="">-- All Classes --</option>';
        classes.forEach(c => {
          const name = typeof c === 'object' ? c.class_name : c;
          ttClass.innerHTML += `<option value="${name}">${name}</option>`;
        });
      }
      if (ttTeacher) {
        ttTeacher.innerHTML = '<option value="">-- Select Teacher --</option>';
        teachers.forEach(t => { ttTeacher.innerHTML += `<option value="${t.id}">${t.name}</option>`; });
      }
    } catch (e) {}
  }

  document.getElementById('tt-class').addEventListener('change', async () => {
    const class_name = document.getElementById('tt-class').value;
    const ttSection = document.getElementById('tt-section');
    ttSection.innerHTML = '<option value="">-- All Sections --</option>';
    if (!class_name) return;
    try {
      const sections = await apiCall(`/students/sections/${encodeURIComponent(class_name)}`);
      sections.forEach(s => { ttSection.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`; });
    } catch (e) {}
  });

  document.getElementById('btn-load-timetable').addEventListener('click', loadTimetableGrid);

  async function loadTimetableGrid() {
    const class_name = document.getElementById('tt-class').value;
    const section_name = document.getElementById('tt-section').value;

    const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const selectedDays = Array.from(document.querySelectorAll('.tt-day-filter:checked')).map(cb => cb.value);
    if (selectedDays.length === 0) { showToast('Select at least one day', true); return; }

    try {
      let url = `/staff/timetable?`;
      if (class_name) url += `class_name=${encodeURIComponent(class_name)}&`;
      if (section_name) url += `section_name=${encodeURIComponent(section_name)}&`;
      const entries = await apiCall(url);

      const periods = [1,2,3,4,5,6,7,8];
      const dayAbbr = {Monday:'Mon',Tuesday:'Tue',Wednesday:'Wed',Thursday:'Thu',Friday:'Fri',Saturday:'Sat'};
      const headerCols = selectedDays.map(d => {
        const bg = allDays.indexOf(d) % 2 === 0 ? 'rgba(99,102,241,0.15)' : 'rgba(139,92,246,0.15)';
        return `<th style="background: ${bg}; text-align: center;">${dayAbbr[d] || d}</th>`;
      }).join('');

      // Update dynamic header
      document.getElementById('timetable-head').innerHTML = `<tr>
        <th style="background: rgba(255,255,255,0.08); text-align: center; min-width: 50px;">Period</th>
        ${headerCols}
      </tr>`;

      if (class_name) {
        // Grid view for a specific class
        const grid = {};
        const allDayEntries = {};
        entries.forEach(e => {
          if (e.day === 'all') {
            allDayEntries[e.period] = e;
          } else {
            grid[`${e.day}-${e.period}`] = e;
          }
        });

        // Merge old per-day duplicates into allDayEntries
        const allDays = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
        periods.forEach(p => {
          if (allDayEntries[p]) return;
          const dayEntries = allDays.map(d => grid[`${d}-${p}`]).filter(e => e && e.subject);
          if (dayEntries.length >= 6) {
            const first = dayEntries[0];
            const isSame = dayEntries.every(e =>
              e.subject === first.subject && e.teacher_id === first.teacher_id &&
              e.start_time === first.start_time && e.end_time === first.end_time
            );
            if (isSame) {
              allDayEntries[p] = first;
              allDays.forEach(d => delete grid[`${d}-${p}`]);
            }
          }
        });

        const tbody = document.getElementById('timetable-body');
        tbody.innerHTML = periods.map(p => {
          // "All Days" entry — show once as merged cell
          const allEntry = allDayEntries[p];
          if (allEntry && allEntry.subject) {
            const teacherText = allEntry.teacher_name ? `<br><span style="color:#8b5cf6; font-weight:600;">${allEntry.teacher_name}</span>` : '';
            const timeText = (allEntry.start_time || allEntry.end_time) ? `<br><span style="opacity:0.6; font-size:0.7rem;">${allEntry.start_time || ''}${allEntry.start_time && allEntry.end_time ? ' - ' : ''}${allEntry.end_time || ''}</span>` : '';
            const colSpan = selectedDays.length;
            return `<tr>
              <td style="font-weight: 700; text-align: center; background: rgba(255,255,255,0.05);">${p}</td>
              <td colspan="${colSpan}" style="background: rgba(34,197,94,0.1); border-left: 3px solid #22c55e; text-align: center; cursor: pointer;" class="tt-cell"
                data-id="${allEntry.id}" data-day="all" data-period="${p}" data-subject="${allEntry.subject || ''}"
                data-teacher="${allEntry.teacher_id || ''}" data-start="${allEntry.start_time || ''}"
                data-end="${allEntry.end_time || ''}" data-class="${allEntry.class_name || ''}" data-section="${allEntry.section_name || ''}">
                <div style="font-size: 0.8rem;">
                  <strong style="color: #4ade80;">${allEntry.subject}</strong>
                  ${teacherText}
                  ${timeText}
                </div>
                <div class="tt-cell-actions">
                  <button class="tt-btn-edit" title="Edit" onclick="ttEditEntry(${allEntry.id}, 'all', ${p}, '${(allEntry.subject||'').replace(/'/g,"\\'")}', '${allEntry.teacher_id||''}', '${(allEntry.start_time||'').replace(/'/g,"\\'")}', '${(allEntry.end_time||'').replace(/'/g,"\\'")}', '${(allEntry.class_name||'').replace(/'/g,"\\'")}', '${(allEntry.section_name||'').replace(/'/g,"\\'")}')">&#9998;</button>
                  <button class="tt-btn-delete" title="Delete" onclick="ttDeleteEntry(${allEntry.id})">&#10005;</button>
                </div>
              </td>
            </tr>`;
          }

          // Normal per-day entries
          const tds = selectedDays.map(d => {
            const e = grid[`${d}-${p}`];
            if (e && e.subject) {
              const teacherText = e.teacher_name ? `<br><span style="color:#8b5cf6; font-weight:600;">${e.teacher_name}</span>` : '';
              const timeText = (e.start_time || e.end_time) ? `<br><span style="opacity:0.6; font-size:0.7rem;">${e.start_time || ''}${e.start_time && e.end_time ? ' - ' : ''}${e.end_time || ''}</span>` : '';
              return `<td style="background: rgba(99,102,241,0.08); border-left: 3px solid #6366f1; position: relative;" class="tt-cell"
                data-id="${e.id}" data-day="${d}" data-period="${p}" data-subject="${e.subject || ''}"
                data-teacher="${e.teacher_id || ''}" data-start="${e.start_time || ''}"
                data-end="${e.end_time || ''}" data-class="${e.class_name || ''}" data-section="${e.section_name || ''}">
                <div style="font-size: 0.8rem;">
                  <strong style="color: #a5b4fc;">${e.subject}</strong>
                  ${teacherText}
                  ${timeText}
                </div>
                <div class="tt-cell-actions">
                  <button class="tt-btn-edit" title="Edit" onclick="ttEditEntry(${e.id}, '${(e.day||'').replace(/'/g,"\\'")}', ${e.period}, '${(e.subject||'').replace(/'/g,"\\'")}', '${e.teacher_id||''}', '${(e.start_time||'').replace(/'/g,"\\'")}', '${(e.end_time||'').replace(/'/g,"\\'")}', '${(e.class_name||'').replace(/'/g,"\\'")}', '${(e.section_name||'').replace(/'/g,"\\'")}')">&#9998;</button>
                  <button class="tt-btn-delete" title="Delete" onclick="ttDeleteEntry(${e.id})">&#10005;</button>
                </div>
              </td>`;
            }
            return `<td style="background: rgba(255,255,255,0.02); cursor: pointer;"
              class="tt-cell" data-day="${d}" data-period="${p}" onclick="ttCellClick('${(d||'').replace(/'/g,"\\'")}', ${p})">-</td>`;
          }).join('');
          return `<tr><td style="font-weight: 700; text-align: center; background: rgba(255,255,255,0.05);">${p}</td>${tds}</tr>`;
        }).join('');

        document.getElementById('teacher-timetable-summary').style.display = 'none';
      } else {
        // All classes - teacher-wise summary with edit/delete
        document.getElementById('timetable-body').innerHTML = `<tr><td colspan="${selectedDays.length + 1}" style="text-align: center; color: var(--text-muted);">Showing teacher-wise summary below.</td></tr>`;
        document.getElementById('teacher-timetable-summary').style.display = 'block';

        const teacherSummary = document.getElementById('teacher-timetable-body');
        if (entries.length === 0) {
          teacherSummary.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted);">No timetable entries found.</td></tr>';
        } else {
          teacherSummary.innerHTML = entries.map(e => {
            const time = (e.start_time || e.end_time) ? `${e.start_time || ''}${e.start_time && e.end_time ? ' - ' : ''}${e.end_time || ''}` : '-';
            const dayLabel = e.day === 'all' ? 'Mon-Sat' : e.day;
            const dayBadgeClass = e.day === 'all' ? 'badge-green' : 'badge-blue';
            return `<tr>
              <td style="font-weight:600; color:#8b5cf6;">${e.teacher_name || '-'}</td>
              <td>${e.class_name || '-'}</td>
              <td>${e.section_name || '-'}</td>
              <td><span class="badge ${dayBadgeClass}">${dayLabel}</span></td>
              <td style="text-align:center;">${e.period}</td>
              <td>${e.subject || '-'}</td>
              <td style="opacity:0.7;">${time}</td>
              <td>
                <button class="tt-btn-edit" title="Edit" onclick="ttEditEntry(${e.id}, '${(e.day||'').replace(/'/g,"\\'")}', ${e.period}, '${(e.subject||'').replace(/'/g,"\\'")}', '${e.teacher_id||''}', '${(e.start_time||'').replace(/'/g,"\\'")}', '${(e.end_time||'').replace(/'/g,"\\'")}', '${(e.class_name||'').replace(/'/g,"\\'")}', '${(e.section_name||'').replace(/'/g,"\\'")}')">&#9998;</button>
                <button class="tt-btn-delete" title="Delete" onclick="ttDeleteEntry(${e.id})">&#10005;</button>
              </td>
            </tr>`;
          }).join('');
        }
      }
    } catch (e) { showToast('Failed to load timetable', true); }
  }

  // Day filter quick buttons
  document.getElementById('tt-select-all-days').addEventListener('click', () => {
    document.querySelectorAll('.tt-day-filter').forEach(cb => cb.checked = true);
    loadTimetableGrid();
  });
  document.getElementById('tt-select-weekdays').addEventListener('click', () => {
    document.querySelectorAll('.tt-day-filter').forEach(cb => {
      cb.checked = cb.value !== 'Saturday';
    });
    loadTimetableGrid();
  });
  document.querySelectorAll('.tt-day-filter').forEach(cb => {
    cb.addEventListener('change', () => loadTimetableGrid());
  });

  // Click cell to load into form (for new entry)
  window.ttCellClick = function(day, period) {
    document.getElementById('tt-day').value = day;
    document.getElementById('tt-period').value = period;
    document.getElementById('tt-subject').value = '';
    document.getElementById('tt-teacher').value = '';
    document.getElementById('tt-start-time').value = '';
    document.getElementById('tt-end-time').value = '';
    document.getElementById('btn-tt-cancel').style.display = 'inline-block';
    document.getElementById('tt-subject').focus();
  };

  // Edit existing entry - load into form
  window.ttEditEntry = function(id, day, period, subject, teacher_id, start_time, end_time, class_name, section_name) {
    document.getElementById('tt-day').value = day;
    document.getElementById('tt-period').value = period;
    document.getElementById('tt-subject').value = subject;
    document.getElementById('tt-teacher').value = teacher_id;
    document.getElementById('tt-start-time').value = start_time;
    document.getElementById('tt-end-time').value = end_time;
    document.getElementById('btn-tt-cancel').style.display = 'inline-block';
    showToast('Editing: ' + subject + ' (Period ' + period + ' ' + day + ')');
  };

  // Delete single entry
  window.ttDeleteEntry = async function(id) {
    if (!confirm('Delete this timetable entry?')) return;
    try {
      await apiCall('/staff/timetable/' + id, 'DELETE');
      showToast('Entry deleted');
      loadTimetableGrid();
    } catch (err) { showToast(err.message, true); }
  };

  document.getElementById('form-timetable').addEventListener('submit', async (e) => {
    e.preventDefault();
    const class_name = document.getElementById('tt-class').value;
    const section_name = document.getElementById('tt-section').value;
    const day = document.getElementById('tt-day').value;
    const period = parseInt(document.getElementById('tt-period').value);
    const subject = document.getElementById('tt-subject').value.trim();
    const teacher_id = document.getElementById('tt-teacher').value || null;
    const start_time = document.getElementById('tt-start-time').value;
    const end_time = document.getElementById('tt-end-time').value;

    if (!class_name || !subject) { showToast('Class and subject are required', true); return; }

    try {
      await apiCall('/staff/timetable', 'POST', {
        class_name, section_name, day, period, start_time, end_time,
        subject, teacher_id: teacher_id ? parseInt(teacher_id) : null
      });
      showToast('Period saved');
      document.getElementById('form-timetable').reset();
      document.getElementById('btn-tt-cancel').style.display = 'none';
      loadTimetableGrid();
    } catch (err) { showToast(err.message, true); }
  });

  document.getElementById('btn-tt-cancel').addEventListener('click', () => {
    document.getElementById('form-timetable').reset();
    document.getElementById('btn-tt-cancel').style.display = 'none';
  });

  document.getElementById('btn-clear-timetable').addEventListener('click', async () => {
    const class_name = document.getElementById('tt-class').value;
    const section_name = document.getElementById('tt-section').value;
    const target = class_name ? `timetable for class ${class_name}` : 'ALL timetable entries';
    if (!confirm(`Clear ${target}?`)) return;
    try {
      let url = `/staff/timetable?`;
      if (class_name) url += `class_name=${encodeURIComponent(class_name)}&`;
      if (section_name) url += `section_name=${encodeURIComponent(section_name)}&`;
      await apiCall(url, 'DELETE');
      showToast('Timetable cleared');
      loadTimetableGrid();
    } catch (err) { showToast(err.message, true); }
  });

  // ==========================================
  // ANNOUNCEMENTS
  // ==========================================

  async function loadAnnouncementsList() {
    try {
      const announcements = await apiCall('/staff/announcements');
      const container = document.getElementById('announcements-admin-list');
      if (!container) return;

      if (announcements.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">No announcements yet.</p>';
        return;
      }

      container.innerHTML = announcements.map(a => {
        const date = a.created_at ? new Date(a.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const targetBadge = a.target_role === 'all' ? 'badge-blue' : a.target_role === 'teachers' ? 'badge-green' : 'badge-purple';
        const targetLabel = a.target_role === 'all' ? 'All' : a.target_role === 'teachers' ? 'Teachers' : 'Parents';
        return `
        <div style="border: 1px solid var(--border-glow); border-radius: 12px; padding: 16px; margin-bottom: 12px; background: rgba(255,255,255,0.02);">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
            <div>
              <h4 style="margin: 0; color: var(--text-primary);">${a.title}</h4>
              <div style="display: flex; gap: 8px; margin-top: 4px;">
                <span class="badge ${targetBadge}" style="font-size: 0.75rem;">${targetLabel}</span>
                <small style="color: var(--text-muted);">${date}</small>
                <small style="color: var(--text-muted);">By: ${a.created_by || 'Admin'}</small>
              </div>
            </div>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-outline btn-sm btn-edit-announcement" data-id="${a.id}" data-title="${a.title}" data-message="${a.message}" data-target="${a.target_role}">Edit</button>
              <button class="btn btn-danger btn-sm btn-delete-announcement" data-id="${a.id}">Delete</button>
            </div>
          </div>
          <p style="color: var(--text-muted); margin: 8px 0 0; font-size: 0.95rem; white-space: pre-wrap;">${a.message}</p>
        </div>`;
      }).join('');

      container.querySelectorAll('.btn-edit-announcement').forEach(btn => {
        btn.addEventListener('click', () => {
          document.getElementById('announcement-edit-id').value = btn.dataset.id;
          document.getElementById('announcement-title').value = btn.dataset.title;
          document.getElementById('announcement-message').value = btn.dataset.message;
          document.getElementById('announcement-target').value = btn.dataset.target;
          document.getElementById('announcement-form-title').textContent = 'Edit Announcement';
          document.getElementById('btn-announcement-submit').textContent = 'Update Announcement';
          document.getElementById('btn-announcement-cancel').style.display = 'inline-block';
        });
      });

      container.querySelectorAll('.btn-delete-announcement').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Delete this announcement?')) return;
          try {
            await apiCall(`/staff/announcements/${btn.dataset.id}`, 'DELETE');
            showToast('Announcement deleted');
            loadAnnouncementsList();
          } catch (e) { showToast(e.message, true); }
        });
      });
    } catch (e) { showToast('Failed to load announcements', true); }
  }

  document.getElementById('form-announcement').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('announcement-edit-id').value;
    const title = document.getElementById('announcement-title').value.trim();
    const message = document.getElementById('announcement-message').value.trim();
    const target_role = document.getElementById('announcement-target').value;

    try {
      if (editId) {
        await apiCall(`/staff/announcements/${editId}`, 'PUT', { title, message, target_role });
        showToast('Announcement updated');
      } else {
        await apiCall('/staff/announcements', 'POST', { title, message, target_role });
        showToast('Announcement posted');
      }
      document.getElementById('form-announcement').reset();
      document.getElementById('announcement-edit-id').value = '';
      document.getElementById('announcement-form-title').textContent = 'Post New Announcement';
      document.getElementById('btn-announcement-submit').textContent = 'Post Announcement';
      document.getElementById('btn-announcement-cancel').style.display = 'none';
      loadAnnouncementsList();
    } catch (err) { showToast(err.message, true); }
  });

  document.getElementById('btn-announcement-cancel').addEventListener('click', () => {
    document.getElementById('form-announcement').reset();
    document.getElementById('announcement-edit-id').value = '';
    document.getElementById('announcement-form-title').textContent = 'Post New Announcement';
    document.getElementById('btn-announcement-submit').textContent = 'Post Announcement';
    document.getElementById('btn-announcement-cancel').style.display = 'none';
  });

  // ==========================================
  // ==========================================
  // RESULT POST CREATOR LOGIC
  // ==========================================
  let rpRowCount = 0;

  // Mode switching
  const btnRpModeUpload = document.getElementById('rp-mode-upload');
  const btnRpModeManual = document.getElementById('rp-mode-manual');
  const rpOcrSection = document.getElementById('rp-ocr-section');
  const rpManualSection = document.getElementById('rp-manual-section');

  if (btnRpModeUpload) {
    btnRpModeUpload.addEventListener('click', () => {
      btnRpModeUpload.className = 'btn btn-primary btn-sm';
      btnRpModeManual.className = 'btn btn-outline btn-sm';
      rpOcrSection.style.display = 'block';
      rpManualSection.style.display = 'none';
    });
  }
  if (btnRpModeManual) {
    btnRpModeManual.addEventListener('click', () => {
      btnRpModeManual.className = 'btn btn-primary btn-sm';
      btnRpModeUpload.className = 'btn btn-outline btn-sm';
      rpOcrSection.style.display = 'none';
      rpManualSection.style.display = 'block';
    });
  }

  function addRpRow(roll, name, father, marks) {
    rpRowCount++;
    const id = rpRowCount;
    const container = document.getElementById('rp-rows-container');
    const div = document.createElement('div');
    div.id = 'rp-row-' + id;
    div.style.cssText = 'display:grid; grid-template-columns:1.2fr 1.5fr 1.5fr 0.8fr auto; gap:8px; margin-bottom:8px; align-items:center;';
    div.innerHTML =
      '<input type="text" class="form-control" placeholder="Roll No" value="' + (roll||'') + '" style="font-size:0.85rem; padding:6px 8px;">' +
      '<input type="text" class="form-control" placeholder="Student Name" value="' + (name||'') + '" style="font-size:0.85rem; padding:6px 8px;">' +
      '<input type="text" class="form-control" placeholder="Father Name" value="' + (father||'') + '" style="font-size:0.85rem; padding:6px 8px;">' +
      '<input type="number" class="form-control" placeholder="Marks" value="' + (marks||'') + '" style="font-size:0.85rem; padding:6px 8px;">' +
      '<button type="button" class="btn btn-danger btn-sm" onclick="document.getElementById(\'rp-row-'+id+'\').remove();" style="padding:4px 8px;">&times;</button>';
    container.appendChild(div);
  }

  const btnRpAddRow = document.getElementById('btn-rp-add-row');
  if (btnRpAddRow) btnRpAddRow.addEventListener('click', () => addRpRow());

  // OCR Extract
  const btnRpExtract = document.getElementById('btn-rp-extract');
  if (btnRpExtract) {
    btnRpExtract.addEventListener('click', async () => {
      const fileInput = document.getElementById('rp-result-image');
      if (!fileInput.files[0]) { showToast('Please select an image first', true); return; }

      const statusEl = document.getElementById('rp-ocr-status');
      const previewEl = document.getElementById('rp-ocr-preview');
      statusEl.style.display = 'block';
      previewEl.style.display = 'none';
      statusEl.textContent = '⏳ Loading OCR engine...';
      btnRpExtract.disabled = true;

      try {
        statusEl.textContent = '⏳ Loading OCR engine...';

        // Read image as data URL first
        const imageDataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(fileInput.files[0]);
        });

        statusEl.textContent = '⏳ Recognizing text... This may take a moment.';

        // Use simple recognize API
        const result = await Tesseract.recognize(imageDataUrl, 'eng', {
          logger: m => {
            if (m.status === 'recognizing text') {
              statusEl.textContent = '⏳ Recognizing text... ' + Math.round(m.progress * 100) + '%';
            }
          }
        });

        const ocrText = (result.data && result.data.text) ? result.data.text : '';
        document.getElementById('rp-ocr-text').value = ocrText;
        previewEl.style.display = 'block';
        statusEl.textContent = '✅ Text extracted! Review below and click Parse.';
      } catch (e) {
        console.error('OCR Error:', e);
        const errMsg = (e && e.message) ? e.message : (typeof e === 'string' ? e : 'Unknown error');
        statusEl.textContent = '❌ OCR failed: ' + errMsg;
        showToast('OCR failed: ' + errMsg, true);
      }
      btnRpExtract.disabled = false;
    });
  }

  // Parse OCR text into student rows
  const btnRpParseText = document.getElementById('btn-rp-parse-text');
  if (btnRpParseText) {
    btnRpParseText.addEventListener('click', () => {
      const text = document.getElementById('rp-ocr-text').value;
      if (!text.trim()) { showToast('No text to parse', true); return; }

      const lines = text.split('\n').map(l => l.trim()).filter(l => l);
      const students = [];

      lines.forEach(line => {
        // Skip headers and short lines
        if (/^(roll|name|father|marks|#|no|sr|serial|class|exam|term|result|position|total|obtained)/i.test(line)) return;
        if (line.length < 5) return;

        // Clean line: remove pipes, dashes used as separators, normalize spaces
        let cleaned = line
          .replace(/\|/g, ' ')           // pipe to space
          .replace(/\s*[-–—]\s*/g, ' ')  // dashes to space
          .replace(/\s{2,}/g, '  ')      // normalize multiple spaces to double-space
          .trim();

        // Strategy 1: Split by double-space (most tabular OCR output)
        let parts = cleaned.split(/\s{2,}/).map(p => p.trim()).filter(p => p);
        if (parts.length < 2) {
          // Strategy 2: Split by single space
          parts = cleaned.split(/\s+/).map(p => p.trim()).filter(p => p);
        }

        if (parts.length < 2) return;

        // Find the last numeric part (marks)
        const lastPart = parts[parts.length - 1];
        const marks = parseInt(lastPart.replace(/[^0-9]/g, ''));

        if (isNaN(marks) || marks < 1 || marks > 10000) return;

        // Remove the marks part, remaining is: roll?, name, father?
        const dataParts = parts.slice(0, parts.length - 1);
        if (dataParts.length < 1) return;

        let roll = '', name = '', father = '';

        if (dataParts.length === 1) {
          // Only name
          name = dataParts[0];
        } else if (dataParts.length === 2) {
          // name + father (or roll + name)
          const firstIsNum = /^\d{3,}$/.test(dataParts[0]);
          if (firstIsNum) {
            roll = dataParts[0];
            name = dataParts[1];
          } else {
            name = dataParts[0];
            father = dataParts[1];
          }
        } else if (dataParts.length === 3) {
          // roll + name + father
          const firstIsNum = /^\d{3,}$/.test(dataParts[0]);
          if (firstIsNum) {
            roll = dataParts[0];
            name = dataParts[1];
            father = dataParts[2];
          } else {
            // Could be name + middle + father, treat first as name
            name = dataParts[0];
            father = dataParts.slice(1).join(' ');
          }
        } else {
          // 4+ parts: roll + name + father + extra
          const firstIsNum = /^\d{3,}$/.test(dataParts[0]);
          if (firstIsNum) {
            roll = dataParts[0];
            name = dataParts[1];
            father = dataParts.slice(2).join(' ');
          } else {
            name = dataParts[0];
            father = dataParts.slice(1).join(' ');
          }
        }

        // Validate: name must have letters
        if (name && /[a-zA-Z]{2,}/.test(name)) {
          students.push({ roll, name, father, marks });
        }
      });

      if (students.length === 0) {
        showToast('Could not parse students. Try editing the text or use Manual Entry.', true);
        return;
      }

      // Sort by marks descending
      students.sort((a, b) => b.marks - a.marks);

      // Clear existing rows and fill
      document.getElementById('rp-rows-container').innerHTML = '';
      rpRowCount = 0;
      students.forEach(s => addRpRow(s.roll, s.name, s.father, s.marks));

      showToast(students.length + ' students parsed and added!');
    });
  }

  // Generate Result Post
  const btnRpGenerate = document.getElementById('btn-rp-generate');
  if (btnRpGenerate) {
    btnRpGenerate.addEventListener('click', () => {
      const className = document.getElementById('rp-class-name').value.trim();
      const examName = document.getElementById('rp-exam-name').value.trim();
      if (!className || !examName) { showToast('Please fill class and exam name', true); return; }

      const rows = document.querySelectorAll('#rp-rows-container > div');
      if (rows.length === 0) { showToast('Add at least one student', true); return; }

      const students = [];
      rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        const roll = inputs[0].value.trim();
        const name = inputs[1].value.trim();
        const father = inputs[2].value.trim();
        const marks = parseInt(inputs[3].value) || 0;
        if (name) students.push({ roll, name, father, marks });
      });
      if (students.length === 0) { showToast('Enter at least one student name', true); return; }

      students.sort((a, b) => b.marks - a.marks);

      const schoolName = currentUser ? currentUser.schoolName : 'School Name';

      apiCall('/settings').then(set => {
        const logoUrl = set.logo_path ? '/' + set.logo_path : 'school_assets/school_logo.png';
        renderResultPost(schoolName, logoUrl, className, examName, students);
      }).catch(() => {
        renderResultPost(schoolName, 'school_assets/school_logo.png', className, examName, students);
      });
    });
  }

  function renderResultPost(schoolName, logoUrl, className, examName, students) {
    const tableRows = students.map((s, i) => {
      const bg = i % 2 === 0 ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)';
      return '<tr style="background:' + bg + ';">' +
        '<td style="padding:9px 12px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.82rem; text-align:center;">' + (i + 1) + '</td>' +
        '<td style="padding:9px 12px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.82rem;">' + s.roll + '</td>' +
        '<td style="padding:9px 12px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.82rem; font-weight:600;">' + s.name + '</td>' +
        '<td style="padding:9px 12px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.82rem;">' + s.father + '</td>' +
        '<td style="padding:9px 12px; border-bottom:1px solid rgba(255,255,255,0.1); font-size:0.82rem; font-weight:700; text-align:center; color:#ffd700;">' + s.marks + '</td>' +
        '</tr>';
    }).join('');

    const html =
      '<div id="rp-result-post" style="width:700px; font-family:Georgia,Times,serif; color:#fff; background:linear-gradient(170deg, #1a3a1a 0%, #0d260d 40%, #1a3a1a 60%, #2d5a1e 100%); position:relative; overflow:hidden;">' +
        '<div style="position:absolute; top:-80px; right:-80px; width:300px; height:300px; border-radius:50%; border:3px solid rgba(212,175,55,0.3); pointer-events:none;"></div>' +
        '<div style="position:absolute; top:-40px; right:-40px; width:200px; height:200px; border-radius:50%; border:2px solid rgba(212,175,55,0.2); pointer-events:none;"></div>' +
        '<div style="position:absolute; bottom:-60px; left:-60px; width:250px; height:250px; border-radius:50%; border:3px solid rgba(212,175,55,0.3); pointer-events:none;"></div>' +
        '<div style="height:4px; background:linear-gradient(90deg, transparent, #d4af37, transparent);"></div>' +
        '<div style="text-align:center; padding:28px 30px 18px;">' +
          '<div style="display:flex; align-items:center; justify-content:center; gap:16px;">' +
            '<img src="' + logoUrl + '" style="width:70px; height:70px; border-radius:50%; border:2px solid #d4af37; object-fit:cover;" onerror="this.style.display=\'none\'">' +
            '<h1 style="margin:0; font-size:1.8rem; font-weight:900; color:#fff; text-shadow:2px 2px 4px rgba(0,0,0,0.5); letter-spacing:1px; font-family:Georgia,serif;">' + schoolName + '</h1>' +
          '</div>' +
        '</div>' +
        '<div style="text-align:center; padding:12px 20px; margin:0 30px; background:linear-gradient(90deg, #2d5a1e, #3a7a28, #2d5a1e); border:1px solid #d4af37; border-radius:6px;">' +
          '<h2 style="margin:0; font-size:1.15rem; font-weight:700; color:#d4af37; letter-spacing:1px; font-family:Georgia,serif;">' + className + ' ' + examName + '</h2>' +
        '</div>' +
        '<div style="padding:18px 30px;">' +
          '<table style="width:100%; border-collapse:collapse;">' +
            '<thead><tr style="background:rgba(212,175,55,0.15);">' +
              '<th style="padding:10px 12px; text-align:center; font-size:0.8rem; color:#d4af37; border-bottom:2px solid #d4af37; width:5%;">#</th>' +
              '<th style="padding:10px 12px; text-align:left; font-size:0.8rem; color:#d4af37; border-bottom:2px solid #d4af37; width:12%;">Roll No</th>' +
              '<th style="padding:10px 12px; text-align:left; font-size:0.8rem; color:#d4af37; border-bottom:2px solid #d4af37; width:30%;">Name</th>' +
              '<th style="padding:10px 12px; text-align:left; font-size:0.8rem; color:#d4af37; border-bottom:2px solid #d4af37;">Father Name</th>' +
              '<th style="padding:10px 12px; text-align:center; font-size:0.8rem; color:#d4af37; border-bottom:2px solid #d4af37; width:12%;">Marks</th>' +
            '</tr></thead>' +
            '<tbody>' + tableRows + '</tbody>' +
          '</table>' +
        '</div>' +
        '<div style="height:4px; background:linear-gradient(90deg, transparent, #d4af37, transparent);"></div>' +
        '<div style="display:flex; justify-content:space-between; align-items:center; padding:22px 30px; background:linear-gradient(135deg, #1a3a1a, #2d5a1e);">' +
          '<div style="display:flex; align-items:center; gap:10px;">' +
            '<div style="font-size:1.8rem;">📚</div>' +
            '<div style="font-size:0.7rem; color:#d4af37; font-weight:700; line-height:1.3; text-transform:uppercase;">Education<br>is the key to<br>success</div>' +
          '</div>' +
          '<div style="text-align:center; font-size:2rem;">🏆</div>' +
          '<div style="text-align:right;">' +
            '<p style="margin:0; font-size:1.05rem; font-style:italic; color:#d4af37; font-family:Georgia,serif;">Congratulations to all</p>' +
            '<p style="margin:0; font-size:0.9rem; font-style:italic; color:#fff; font-family:Georgia,serif;">our brilliant students!</p>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('rp-preview').innerHTML = html;
    document.getElementById('rp-preview').style.cssText = 'padding:0; display:block; background:#111;';
    document.getElementById('btn-rp-download').style.display = 'block';
  }

  // Download as image
  const btnRpDownload = document.getElementById('btn-rp-download');
  if (btnRpDownload) {
    btnRpDownload.addEventListener('click', async () => {
      const postEl = document.getElementById('rp-result-post');
      if (!postEl) { showToast('Generate a post first', true); return; }

      showToast('Preparing download...');

      try {
        // Use html-to-image approach via canvas
        const scale = 2;
        const w = 700;
        const h = postEl.offsetHeight;

        // Create a serialized HTML document
        const htmlContent = '<!DOCTYPE html><html><head><meta charset="utf-8">' +
          '<style>*{margin:0;padding:0;box-sizing:border-box;}body{width:' + w + 'px;background:transparent;}</style>' +
          '</head><body>' + postEl.outerHTML + '</body></html>';

        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = function() {
          const canvas = document.createElement('canvas');
          canvas.width = w * scale;
          canvas.height = h * scale;
          const ctx = canvas.getContext('2d');
          ctx.scale(scale, scale);
          ctx.fillStyle = '#1a3a1a';
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);

          canvas.toBlob(function(b) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(b);
            a.download = 'result-post.png';
            a.click();
            URL.revokeObjectURL(a.href);
            showToast('Image downloaded!');
          }, 'image/png');
        };
        img.onerror = function() {
          URL.revokeObjectURL(url);
          // Fallback: open print dialog
          const w2 = window.open('', '_blank');
          w2.document.write('<!DOCTYPE html><html><head><title>Result Post</title><style>@page{margin:0;}body{margin:0;padding:0;width:700px;}</style></head><body>' + postEl.outerHTML + '</body></html>');
          w2.document.close();
          w2.print();
          showToast('Use Save as PDF from print dialog');
        };
        img.src = url;
      } catch(e) {
        showToast('Download failed. Try browser screenshot.', true);
      }
    });
  }

  // INITIALIZATIONS
  // ==========================================
  checkBillingStatus();
  loadDashboardStats();

});
