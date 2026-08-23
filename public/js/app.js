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

  // REST API Client helper
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
      const container = btn.closest('.screen-section');
      
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

      const selects = [
        filterClass, attClassSelect, attHistoryClass, ledgerFilterClass,
        subClassSelect, viewSubClass, marksSelectClass, calcClassSelect
      ];

      selects.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        sel.innerHTML = sel.id === 'student-filter-class' ? '<option value="">All Classes</option>' : '';
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
  function loadFeesData() {
    loadClassesList();
    loadClassFeeRules();
    
    // Fill year select options
    const yearSelect = document.getElementById('fee-gen-year');
    const examYearSelect = document.getElementById('exam-create-year');
    const currentYear = new Date().getFullYear();
    [yearSelect, examYearSelect].forEach(sel => {
      if (!sel) return;
      sel.innerHTML = '';
      for (let y = currentYear; y >= currentYear - 5; y--) {
        sel.innerHTML += `<option value="${y}">${y}</option>`;
      }
    });

    // Default target billing month
    document.getElementById('fee-gen-month').value = new Date().toLocaleString('en-US', { month: 'long' });
  }

  // Load Fee setup rules
  async function loadClassFeeRules() {
    try {
      const fees = await apiCall('/fees/setup');
      const tbody = document.querySelector('#table-fee-setup-rules tbody');
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
  document.getElementById('form-fee-setup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const class_name = document.getElementById('fee-setup-class').value.trim();
    const monthly_fee = document.getElementById('fee-setup-amount').value;

    try {
      const res = await apiCall('/fees/setup', 'POST', { class_name, monthly_fee });
      showToast(res.message);
      document.getElementById('form-fee-setup').reset();
      loadClassFeeRules();
    } catch (err) {}
  });

  // Run ledger generator
  document.getElementById('form-fee-generate').addEventListener('submit', async (e) => {
    e.preventDefault();
    const feedback = document.getElementById('fee-gen-feedback');
    feedback.innerText = 'Calculating ledgers... Please wait.';
    feedback.style.display = 'block';

    const month = document.getElementById('fee-gen-month').value;
    const year = document.getElementById('fee-gen-year').value;

    try {
      const res = await apiCall('/fees/generate', 'POST', { month, year });
      feedback.innerText = res.message;
      showToast(res.message);
      loadDashboardStats();
    } catch (err) {
      feedback.innerText = 'Failed to generate fees: ' + err.message;
    }
  });

  // Search Pending Invoices
  document.getElementById('btn-search-pay-ledger').addEventListener('click', async () => {
    const search = document.getElementById('fee-pay-search').value.trim();
    const status = document.getElementById('fee-pay-filter-status').value;

    let endpoint = '/fees/ledger?';
    if (status) endpoint += `status=${status}&`;

    try {
      const ledgers = await apiCall(endpoint);
      const tbody = document.querySelector('#table-unpaid-ledgers tbody');
      tbody.innerHTML = '';

      // Filter local search
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

      // Bind collect fee button click
      attachFeePaymentFormEvents();

    } catch (e) {}
  });

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

  document.getElementById('btn-close-tx-modal').addEventListener('click', () => {
    modalTx.classList.remove('open');
  });

  // Record Transaction Action (POST)
  document.getElementById('form-fee-pay-record').addEventListener('submit', async (e) => {
    e.preventDefault();
    const ledger_id = document.getElementById('tx-ledger-id').value;
    const amount_paid = document.getElementById('tx-pay-amount').value;
    const payment_date = document.getElementById('tx-pay-date').value;

    try {
      const res = await apiCall('/fees/pay', 'POST', { ledger_id, amount_paid, payment_date });
      showToast(res.message);
      modalTx.classList.remove('open');
      
      // Refresh statistics and list
      loadDashboardStats();
      document.getElementById('btn-search-pay-ledger').click();
    } catch (err) {}
  });

  // Ledger Logs List
  document.getElementById('btn-load-ledger-logs').addEventListener('click', async () => {
    const cls = document.getElementById('ledger-filter-class').value;
    const month = document.getElementById('ledger-filter-month').value;
    const status = document.getElementById('ledger-filter-status').value;

    let endpoint = '/fees/ledger?';
    if (cls) endpoint += `class_name=${encodeURIComponent(cls)}&`;
    if (month) endpoint += `month=${month}&`;
    if (status) endpoint += `status=${status}&`;

    try {
      const list = await apiCall(endpoint);
      const tbody = document.querySelector('#table-ledger-logs tbody');
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


  // ==========================================
  // MODULE: EXAMS, MARKS & DMCS
  // ==========================================
  function loadExamsData() {
    loadClassesList();
    loadExamsDropdowns();
  }

  // Load exams into select dropdown inputs
  async function loadExamsDropdowns() {
    try {
      const exams = await apiCall('/exams');
      const subExamSelect = document.getElementById('sub-exam-select');
      const viewSubExam = document.getElementById('view-sub-exam');
      const marksSelectExam = document.getElementById('marks-select-exam');
      const calcExamSelect = document.getElementById('calc-exam-select');
      const dmcSelectExam = document.getElementById('dmc-select-exam');

      const selectors = [subExamSelect, viewSubExam, marksSelectExam, calcExamSelect, dmcSelectExam];

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
