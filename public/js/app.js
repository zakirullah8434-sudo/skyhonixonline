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
      const result = await response.json();

      if (response.status === 401 || response.status === 403) {
        if (result.suspended) {
          // Trigger billing lock overlay
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
    });
  });

  // Mobile sidebar toggle
  const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  btnSidebarToggle.addEventListener('click', () => {
    sidebar.classList.toggle('open');
  });

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
      const subClassSelect = document.getElementById('sub-class-select');
      const viewSubClass = document.getElementById('view-sub-class');
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
        subClassSelect, viewSubClass, marksSelectClass, calcClassSelect,
        historyFilterClass, studentFeeClass, reminderFilterClass,
        datesheetClassSelect, rollnoClassSelect, rollnoGenClass
      ];

      selects.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        const isAllClasses = ['student-filter-class', 'history-filter-class', 'student-fee-class'].includes(sel.id);
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
      formData.append('photo', fileInput.files[0]);
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

    if (opt === 'fee-history') {
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
      const yearSelect = document.getElementById('reminder-filter-year');
      if (yearSelect) {
        yearSelect.innerHTML = '';
        for (let y = currentYear; y >= currentYear - 5; y--) {
          yearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
        yearSelect.value = currentYear;
      }
      const monthSelect = document.getElementById('reminder-filter-month');
      if (monthSelect) monthSelect.value = currentMonth;
      const classSelect = document.getElementById('reminder-filter-class');
      if (classSelect) classSelect.value = '';
      const sectionSelect = document.getElementById('reminder-filter-section');
      if (sectionSelect) sectionSelect.innerHTML = '<option value="">-- All Sections --</option>';
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
        loadDashboardStats();
        const paySearchBtn = document.getElementById('btn-search-pay-ledger');
        if (paySearchBtn) paySearchBtn.click();
      } catch (err) {}
    });
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
            <td>${hasLedger ? l.total_payable.toLocaleString() : '-'}</td>
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
            loadHistoryLedger();
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
            loadHistoryLedger();
          } catch (e) {}
        });
      });

    } catch (e) {}
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
        loadHistoryLedger();
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
        loadHistoryLedger();
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
        loadHistoryLedger();
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
  const formFeeReminderPdf = document.getElementById('form-fee-reminder-pdf');
  if (formFeeReminderPdf) {
    formFeeReminderPdf.addEventListener('submit', async (e) => {
      e.preventDefault();
      const cls = document.getElementById('reminder-filter-class').value;
      const sec = document.getElementById('reminder-filter-section').value;
      const month = document.getElementById('reminder-filter-month').value;
      const year = document.getElementById('reminder-filter-year').value;

      let url = `/fees/history-management?month=${month}&year=${year}&class_name=${encodeURIComponent(cls)}`;
      if (sec) url += `&section_name=${encodeURIComponent(sec)}`;

      try {
        const data = await apiCall(url);
        
        // Filter for outstanding balance > 0
        const unpaid = data.filter(l => {
          const remaining = l.ledger_id ? (l.total_payable - l.paid_amount) : l.previous_due;
          return remaining > 0;
        });

        if (unpaid.length === 0) {
          showToast('No students with outstanding dues found for selection.', true);
          return;
        }

        // Generate print layout
        let printHtml = `
          <html>
            <head>
              <title>Fee Reminders - ${cls} - ${month} ${year}</title>
              <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 20px; background: white; color: black; }
                .reminder-slip {
                  border: 2px dashed #000;
                  padding: 30px;
                  margin-bottom: 50px;
                  border-radius: 8px;
                  page-break-inside: avoid;
                  background: #fff;
                }
                .header { text-align: center; border-bottom: 2px solid #000; padding-bottom: 15px; margin-bottom: 20px; }
                .school-name { font-size: 1.8rem; font-weight: bold; text-transform: uppercase; color: #111; letter-spacing: 1px; }
                .title { font-size: 1.3rem; font-weight: bold; margin-top: 8px; color: #444; }
                .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 25px; font-size: 1.05rem; }
                .info-item { margin-bottom: 5px; }
                .info-label { font-weight: bold; color: #333; }
                .fee-table { width: 100%; border-collapse: collapse; margin-bottom: 25px; }
                .fee-table th, .fee-table td { border: 1px solid #000; padding: 10px 14px; text-align: left; font-size: 1rem; }
                .fee-table th { background: #f2f2f2; font-weight: bold; }
                .total-row { font-weight: bold; font-size: 1.15rem; background: #e6e6e6 !important; }
                .footer { margin-top: 30px; display: flex; justify-content: space-between; align-items: flex-end; }
                .note { font-style: italic; font-size: 0.9rem; color: #444; max-width: 65%; line-height: 1.4; }
                .signature { text-align: center; border-top: 2px solid #000; width: 180px; padding-top: 8px; font-size: 0.95rem; font-weight: bold; }
              </style>
            </head>
            <body>
        `;
        
        const currentUser = JSON.parse(localStorage.getItem('skyhonix_user'));

        unpaid.forEach(l => {
          const hasLedger = l.ledger_id !== null;
          const totalPayable = hasLedger ? l.total_payable : (parseFloat(l.previous_due) || 0);
          const amountPaid = hasLedger ? l.paid_amount : 0;
          const remaining = totalPayable - amountPaid;

          printHtml += `
            <div class="reminder-slip">
              <div class="header">
                <div class="school-name">${currentUser.schoolName}</div>
                <div class="title">MONTHLY FEE REMINDER SLIP</div>
              </div>
              <div class="info-grid">
                <div class="info-item"><span class="info-label">Student Name:</span> ${l.name}</div>
                <div class="info-item"><span class="info-label">Father's Name:</span> ${l.father_name || '-'}</div>
                <div class="info-item"><span class="info-label">Class & Sec:</span> ${l.class_name} ${l.section_name ? '(' + l.section_name + ')' : ''}</div>
                <div class="info-item"><span class="info-label">Roll Number:</span> ${l.roll_no || 'N/A'}</div>
                <div class="info-item"><span class="info-label">Reminder Month:</span> ${month} ${year}</div>
                <div class="info-item"><span class="info-label">Ledger Status:</span> ${hasLedger ? l.status : 'Ledger Not Generated'}</div>
              </div>
              <table class="fee-table">
                <thead>
                  <tr>
                    <th>Billing Head</th>
                    <th>Amount (PKR)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Tuition / Sibling Base Fee</td>
                    <td>${hasLedger ? l.monthly_fee.toLocaleString() : '-'}</td>
                  </tr>
                  <tr>
                    <td>Waiver Exception / Discount Applied</td>
                    <td>${hasLedger ? '-' + l.discount.toLocaleString() : '-'}</td>
                  </tr>
                  <tr>
                    <td>Transport Fare</td>
                    <td>${hasLedger ? l.transport_fee.toLocaleString() : '-'}</td>
                  </tr>
                  <tr>
                    <td>Prior Carry Forward Balance</td>
                    <td>${l.previous_due.toLocaleString()}</td>
                  </tr>
                  <tr class="total-row">
                    <td>Total Dues Payable</td>
                    <td>${remaining.toLocaleString()} PKR</td>
                  </tr>
                </tbody>
              </table>
              <div class="footer">
                <div class="note">
                  Please Note: If you have already deposited this fee amount, kindly submit the deposit receipt to the school administration office, or ignore this slip.
                </div>
                <div class="signature">
                  Accounts Office
                </div>
              </div>
            </div>
          `;
        });
        
        printHtml += `
            </body>
          </html>
        `;

        const originalContents = document.body.innerHTML;
        document.body.innerHTML = printHtml;
        window.print();
        window.location.reload();

      } catch (e) {}
    });
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
        let statusIcon = '🔴';
        if (c.status === 'Good') {
          badgeColor = '#4caf50';
          statusIcon = '🟢';
        } else if (c.status === 'Fair') {
          badgeColor = '#ffb142';
          statusIcon = '🟡';
        }

        const isTrendPositive = !c.trend.startsWith('-');
        const trendIcon = isTrendPositive ? '📈' : '📉';
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
              <td><span style="color:var(--accent); font-weight:700;">${l.amount_paid.toLocaleString()} Rs</span></td>
              <td>${(l.total_payable - l.amount_paid).toLocaleString()} Rs</td>
              <td><span class="status-badge ${badge}">${l.status}</span></td>
            </tr>
          `;
        });
      } catch (e) {}
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

    if (opt === 'exam-datesheet') {
      loadDatesheetDesignData();
    } else if (opt === 'exam-rollno') {
      loadRollnoDesignData();
    }
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
      const subExamSelect = document.getElementById('sub-exam-select');
      const viewSubExam = document.getElementById('view-sub-exam');
      const marksSelectExam = document.getElementById('marks-select-exam');
      const calcExamSelect = document.getElementById('calc-exam-select');
      const dmcSelectExam = document.getElementById('dmc-select-exam');
      const datesheetExamSelect = document.getElementById('datesheet-exam-select');
      const rollnoExamSelect = document.getElementById('rollno-exam-select');
      const rollnoGenExam = document.getElementById('rollno-gen-exam');

      const selectors = [subExamSelect, viewSubExam, marksSelectExam, calcExamSelect, dmcSelectExam, datesheetExamSelect, rollnoExamSelect, rollnoGenExam];

      selectors.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = '';
        exams.forEach(ex => {
          sel.innerHTML += `<option value="${ex.id}">${ex.exam_name} (${ex.year})</option>`;
        });
        if (currentVal) sel.value = currentVal;
      });

      // Fetch subjects list for first loaded configurations
      if (exams.length > 0) {
        loadExamSubjectsList();
      }

    } catch (e) {}
  }

  // Create exam registry
  document.getElementById('form-create-exam').addEventListener('submit', async (e) => {
    e.preventDefault();
    const exam_name = document.getElementById('exam-create-name').value;
    const year = document.getElementById('exam-create-year').value;

    try {
      const res = await apiCall('/exams', 'POST', { exam_name, year });
      showToast(res.message);
      loadExamsDropdowns();
    } catch (err) {}
  });

  // Create Exam subject
  document.getElementById('form-create-subject').addEventListener('submit', async (e) => {
    e.preventDefault();
    const exam_id = document.getElementById('sub-exam-select').value;
    const class_name = document.getElementById('sub-class-select').value;
    const subject = document.getElementById('sub-name').value.trim();
    const max_marks = document.getElementById('sub-max-marks').value;
    const term = document.getElementById('sub-term-select').value;

    try {
      const res = await apiCall('/exams/subjects', 'POST', { exam_id, class_name, subject, max_marks, term });
      showToast(res.message);
      document.getElementById('sub-name').value = '';
      loadExamSubjectsList();
    } catch (err) {}
  });

  // Filter Active subjects view list
  async function loadExamSubjectsList() {
    const exam_id = document.getElementById('view-sub-exam').value;
    const class_name = document.getElementById('view-sub-class').value;
    const term = document.getElementById('sub-term-select').value; // fallbacks to first or active

    if (!exam_id || !class_name) return;

    try {
      const list = await apiCall(`/exams/subjects?exam_id=${exam_id}&class_name=${encodeURIComponent(class_name)}&term=${encodeURIComponent(term)}`);
      const tbody = document.querySelector('#table-exam-subjects tbody');
      tbody.innerHTML = '';

      if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color:var(--text-muted);">No subjects found.</td></tr>';
        return;
      }

      list.forEach(sub => {
        tbody.innerHTML += `
          <tr>
            <td><strong>${sub.subject}</strong></td>
            <td>${sub.term}</td>
            <td><strong>${sub.max_marks}</strong></td>
            <td>
              <button class="btn btn-danger btn-sm btn-delete-subject" data-id="${sub.id}">&times;</button>
            </td>
          </tr>
        `;
      });

      // Bind delete action
      document.querySelectorAll('.btn-delete-subject').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-id');
          if (confirm('Delete this exam subject?')) {
            try {
              const res = await apiCall(`/exams/subjects/${id}`, 'DELETE');
              showToast(res.message);
              loadExamSubjectsList();
            } catch (e) {}
          }
        });
      });

    } catch (e) {}
  }

  document.getElementById('view-sub-exam').addEventListener('change', loadExamSubjectsList);
  document.getElementById('view-sub-class').addEventListener('change', loadExamSubjectsList);

  // Marks Matrix loader
  document.getElementById('marks-select-class').addEventListener('change', async (e) => {
    // Populate dynamic subjects for class
    const cls = e.target.value;
    const exam_id = document.getElementById('marks-select-exam').value;
    const term = document.getElementById('marks-select-term').value;
    const subSelect = document.getElementById('marks-select-subject');
    
    subSelect.innerHTML = '';
    if (!cls || !exam_id) return;

    try {
      const list = await apiCall(`/exams/subjects?exam_id=${exam_id}&class_name=${encodeURIComponent(cls)}&term=${encodeURIComponent(term)}`);
      list.forEach(sub => {
        subSelect.innerHTML += `<option value="${sub.subject}">${sub.subject} (Max: ${sub.max_marks})</option>`;
      });
    } catch (e) {}
  });

  // Force subject reload if exam changes on marks grid
  document.getElementById('marks-select-exam').addEventListener('change', () => {
    document.getElementById('marks-select-class').dispatchEvent(new Event('change'));
  });
  document.getElementById('marks-select-term').addEventListener('change', () => {
    document.getElementById('marks-select-class').dispatchEvent(new Event('change'));
  });

  // Load Marks Spreadsheet
  document.getElementById('btn-load-marks-grid').addEventListener('click', async () => {
    const exam_id = document.getElementById('marks-select-exam').value;
    const class_name = document.getElementById('marks-select-class').value;
    const section_name = document.getElementById('marks-select-sec').value;
    const term = document.getElementById('marks-select-term').value;
    const subject = document.getElementById('marks-select-subject').value;

    if (!exam_id || !class_name || !subject) {
      showToast('Exam, Class, and Subject are required', true);
      return;
    }

    try {
      let url = `/exams/marks?exam_id=${exam_id}&class_name=${encodeURIComponent(class_name)}&term=${encodeURIComponent(term)}&subject=${encodeURIComponent(subject)}`;
      if (section_name) url += `&section_name=${encodeURIComponent(section_name)}`;

      const students = await apiCall(url);
      const tbody = document.querySelector('#table-marks-grid tbody');
      tbody.innerHTML = '';

      if (students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center;">No students found in this class</td></tr>';
        document.getElementById('marks-grid-actions').style.display = 'none';
        return;
      }

      students.forEach(s => {
        tbody.innerHTML += `
          <tr data-student-id="${s.id}">
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td><strong>${s.name}</strong></td>
            <td>${s.class_name} - ${s.section_name || 'N/A'}</td>
            <td>
              <input type="number" class="marks-input student-marks-val" value="${s.marks}" min="0" placeholder="Enter score">
            </td>
          </tr>
        `;
      });

      document.getElementById('marks-grid-actions').style.display = 'block';

    } catch (e) {}
  });

  // Save Marks Grid spreadsheet inputs
  document.getElementById('btn-save-marks').addEventListener('click', async () => {
    const exam_id = document.getElementById('marks-select-exam').value;
    const term = document.getElementById('marks-select-term').value;
    const subject = document.getElementById('marks-select-subject').value;

    const rows = document.querySelectorAll('#table-marks-grid tbody tr');
    const marksList = [];

    rows.forEach(row => {
      const student_id = row.getAttribute('data-student-id');
      const marks = row.querySelector('.student-marks-val').value;
      marksList.push({ student_id, marks });
    });

    try {
      const res = await apiCall('/exams/marks', 'POST', { exam_id, subject, term, marksList });
      showToast(res.message);
    } catch (err) {}
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

  // DMC Portal student search
  const dmcSearchInput = document.getElementById('dmc-student-search');
  const dmcStudentsTable = document.querySelector('#table-dmc-students tbody');

  async function searchDmcStudents() {
    const searchVal = dmcSearchInput.value.trim();
    if (!searchVal) return;

    try {
      const list = await apiCall(`/students?search=${encodeURIComponent(searchVal)}`);
      dmcStudentsTable.innerHTML = '';

      if (list.length === 0) {
        dmcStudentsTable.innerHTML = '<tr><td colspan="3" style="text-align: center;">No students matches query</td></tr>';
        return;
      }

      list.forEach(s => {
        dmcStudentsTable.innerHTML += `
          <tr class="clickable-row select-dmc-stud-row" data-id="${s.id}" style="cursor:pointer;">
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td>${s.name}</td>
            <td>${s.class_name}</td>
          </tr>
        `;
      });

      // Bind row clicks
      document.querySelectorAll('.select-dmc-stud-row').forEach(row => {
        row.addEventListener('click', () => {
          document.querySelectorAll('.select-dmc-stud-row').forEach(r => r.style.background = 'none');
          row.style.background = 'rgba(99, 102, 241, 0.15)';
          activeStudentDmcId = row.getAttribute('data-id');
          document.getElementById('dmc-fallback-msg').style.display = 'none';
        });
      });

    } catch (e) {}
  }

  dmcSearchInput.addEventListener('input', searchDmcStudents);

  // Load detailed DMC report card
  document.getElementById('btn-load-dmc-report').addEventListener('click', async () => {
    if (!activeStudentDmcId) {
      showToast('Please search and select a student first', true);
      return;
    }

    const exam_id = document.getElementById('dmc-select-exam').value;
    const term = document.getElementById('dmc-select-term').value;

    try {
      const res = await apiCall(`/exams/dmc/${activeStudentDmcId}?exam_id=${exam_id}&term=${encodeURIComponent(term)}`);
      
      // Update printable sheet values
      document.getElementById('dmc-school-name').innerText = currentUser.schoolName;
      
      const set = await apiCall('/settings');
      document.getElementById('dmc-school-contact').innerText = `Phone: ${set.phone || 'N/A'} | Registration No: ${set.registration_number || 'N/A'}`;

      document.getElementById('dmc-sheet-name').innerText = res.student.name;
      document.getElementById('dmc-sheet-father').innerText = res.student.father_name;
      document.getElementById('dmc-sheet-admno').innerText = res.student.admission_no || '-';
      document.getElementById('dmc-sheet-roll').innerText = res.student.roll_no || '-';
      document.getElementById('dmc-sheet-class').innerText = `${res.student.class_name} - ${res.student.section_name || 'N/A'}`;
      document.getElementById('dmc-sheet-term').innerText = term;

      // Populate subject list
      const tbody = document.querySelector('#table-dmc-sheet-marks tbody');
      tbody.innerHTML = '';
      res.reportDetails.forEach(row => {
        tbody.innerHTML += `
          <tr>
            <td><strong>${row.subject}</strong></td>
            <td>${row.max_marks}</td>
            <td><strong>${row.obtained_marks}</strong></td>
            <td><span class="status-badge ${row.status === 'Pass' ? 'status-present' : 'status-unpaid'}">${row.status}</span></td>
          </tr>
        `;
      });

      // Fills totals card
      document.getElementById('dmc-sheet-total').innerText = res.summary.total;
      document.getElementById('dmc-sheet-obtained').innerText = res.summary.obtained;
      document.getElementById('dmc-sheet-percentage').innerText = res.summary.percentage;
      document.getElementById('dmc-sheet-grade').innerText = res.summary.grade;
      document.getElementById('dmc-sheet-position').innerText = `${res.summary.position} Position`;
      document.getElementById('dmc-sheet-remarks').innerText = res.summary.remarks;

      document.getElementById('dmc-printable-sheet').style.display = 'block';
      document.getElementById('btn-print-dmc').style.display = 'block';

    } catch (err) {}
  });

  // Print DMC Sheet Trigger
  document.getElementById('btn-print-dmc').addEventListener('click', () => {
    const sheetContent = document.getElementById('dmc-printable-sheet').innerHTML;
    const originalBody = document.body.innerHTML;

    document.body.innerHTML = `
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
    // Populate year dropdown for datesheet
    const yearSelect = document.getElementById('datesheet-exam-select');
    if (yearSelect) {
      // Exams already loaded via loadExamsDropdowns
    }
    // Reset rows
    const container = document.getElementById('datesheet-rows-container');
    if (container) {
      container.innerHTML = '';
      datesheetRowCount = 0;
    }
  }

  // Add subject row for date sheet designer
  const btnAddDatesheetRow = document.getElementById('btn-add-datesheet-row');
  if (btnAddDatesheetRow) {
    btnAddDatesheetRow.addEventListener('click', () => {
      datesheetRowCount++;
      const container = document.getElementById('datesheet-rows-container');
      const rowHtml = `
        <div class="grid-3" style="grid-template-columns: 2fr 1fr 1fr; gap: 10px; margin-bottom: 10px; align-items: flex-end;" id="datesheet-row-${datesheetRowCount}">
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Subject</label>
            <input type="text" class="form-control" placeholder="e.g. Mathematics" required>
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Date</label>
            <input type="date" class="form-control" required>
          </div>
          <div class="form-group" style="margin-bottom: 0;">
            <label class="form-label">Time</label>
            <input type="text" class="form-control" placeholder="e.g. 9:00 AM - 12:00 PM" required>
          </div>
        </div>
      `;
      container.insertAdjacentHTML('beforeend', rowHtml);
    });
  }

  // Save date sheet template
  const formDatesheetDesign = document.getElementById('form-datesheet-design');
  if (formDatesheetDesign) {
    formDatesheetDesign.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('datesheet-template-name').value.trim();
      const exam_id = document.getElementById('datesheet-exam-select').value;
      const class_name = document.getElementById('datesheet-class-select').value;
      const term = document.getElementById('datesheet-term-select').value;

      const rows = document.querySelectorAll('#datesheet-rows-container .grid-3');
      if (rows.length === 0) {
        showToast('Please add at least one subject row', true);
        return;
      }

      const subjects = [];
      rows.forEach(row => {
        const inputs = row.querySelectorAll('input');
        subjects.push({
          subject: inputs[0].value,
          date: inputs[1].value,
          time: inputs[2].value
        });
      });

      const template = { exam_id, class_name, term, subjects };
      
      try {
        const res = await apiCall('/exams/datesheets', 'POST', { name, template_json: JSON.stringify(template) });
        showToast(res.message);
        formDatesheetDesign.reset();
        document.getElementById('datesheet-rows-container').innerHTML = '';
        datesheetRowCount = 0;
      } catch (err) {}
    });
  }

  // Load date sheet for preview/print
  const btnLoadDatesheet = document.getElementById('btn-load-datesheet');
  if (btnLoadDatesheet) {
    btnLoadDatesheet.addEventListener('click', async () => {
      showToast('Date sheet preview will be available once templates are saved to the server.', true);
    });
  }

  const btnPrintDatesheet = document.getElementById('btn-print-datesheet');
  if (btnPrintDatesheet) {
    btnPrintDatesheet.addEventListener('click', () => {
      const content = document.getElementById('datesheet-printable-content').innerHTML;
      const originalBody = document.body.innerHTML;
      document.body.innerHTML = `<div style="padding:40px; background:white; color:black; font-family:sans-serif; min-height:100vh;">${content}</div>`;
      window.print();
      window.location.reload();
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

      const template = { exam_id, class_name, term, include_logo, include_qr, per_page };

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

      if (!class_name || !exam_id) {
        showToast('Class and Exam are required', true);
        return;
      }

      try {
        const students = await apiCall(`/students?class_name=${encodeURIComponent(class_name)}`);
        const exam = (await apiCall('/exams')).find(e => e.id == exam_id);
        
        if (students.length === 0) {
          showToast('No students found in this class', true);
          return;
        }

        let slipsHtml = '';
        students.forEach(s => {
          slipsHtml += `
            <div style="border: 2px solid #333; border-radius: 10px; padding: 20px; margin-bottom: 20px; page-break-inside: avoid; display: flex; justify-content: space-between; align-items: center;">
              <div>
                <h3 style="margin:0; font-size: 1.1rem;">${currentUser.schoolName}</h3>
                <p style="margin:5px 0; font-size: 0.9rem;">Exam: ${exam ? exam.exam_name + ' ' + exam.year : '-'}</p>
                <p style="margin:2px 0; font-size: 0.95rem;"><strong>Student:</strong> ${s.name}</p>
                <p style="margin:2px 0; font-size: 0.95rem;"><strong>Class:</strong> ${s.class_name} - ${s.section_name || 'N/A'}</p>
              </div>
              <div style="text-align: center; border: 2px dashed #333; border-radius: 8px; padding: 15px 25px;">
                <p style="margin:0; font-size: 0.8rem; color: #666;">ROLL NO</p>
                <p style="margin:0; font-size: 2rem; font-weight: bold;">${s.roll_no || '-'}</p>
              </div>
            </div>
          `;
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
      const originalBody = document.body.innerHTML;
      document.body.innerHTML = `<div style="padding:40px; background:white; color:black; font-family:sans-serif; min-height:100vh;">${content}</div>`;
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
  document.getElementById('btn-settings-backup').addEventListener('click', () => {
    // Redirect browser directly to token authorized download endpoint
    window.location.href = `/api/settings/backup?token=${token}`;
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
  // INITIALIZATIONS
  // ==========================================
  checkBillingStatus();
  loadDashboardStats();

});
