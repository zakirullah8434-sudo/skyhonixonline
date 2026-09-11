// SkyHonix Workspace Application Logic (SPA Router & REST Clients)

function debounce(fn, ms) { let t; return function(...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); }; }
function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

let _classCache = null, _classCacheTime = 0;
async function getCachedClasses(apiCall) {
  const now = Date.now();
  if (_classCache && _classCache.length > 0 && (now - _classCacheTime) < 300000) return _classCache;
  try {
    const result = await apiCall('/students/classes');
    if (result && result.length > 0) {
      _classCache = result;
      _classCacheTime = Date.now();
    }
    return _classCache || result || [];
  } catch (e) {
    console.error('[CLASSES_CACHE] Failed to load classes:', e);
    return _classCache || [];
  }
}

function invalidateClassCache() {
  _classCache = null;
  _classCacheTime = 0;
}

let _settingsCache = null, _settingsCacheTime = 0;
async function getCachedSettings(apiCall) {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCacheTime) < 300000) return _settingsCache;
  try {
    _settingsCache = await apiCall('/settings');
    _settingsCacheTime = Date.now();
    return _settingsCache;
  } catch (e) { console.error('[SETTINGS_CACHE]', e.message); return _settingsCache || {}; }
}

// Helper: resolve image src for both data URIs and relative file paths
function imgSrc(val, fallback) {
  if (!val) return '/' + (fallback || 'school_assets/school_logo.png');
  if (val.startsWith('data:') || val.startsWith('http://') || val.startsWith('https://') || val.startsWith('/')) return val;
  return '/' + val;
}

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
    if (isError) {
      toast.style.background = '#DC2626';
      toast.style.borderColor = '#FCA5A5';
      toast.style.color = '#FFFFFF';
    } else {
      toast.style.background = '#1E293B';
      toast.style.borderColor = 'var(--primary)';
      toast.style.color = '#F9FAFB';
    }
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

  // REST API Client helper (Enhanced with offline-first sync)
  async function apiCall(endpoint, method = 'GET', body = null, isFormData = false) {
    const isMutation = method !== 'GET' && method !== 'HEAD';

    // Use offline engine only for mutations (POST/PUT/DELETE), not for GET requests
    const resolvedEntity = resolveEntity(endpoint);
    if (window.SkyHonixOffline && window.SkyHonixOffline._initialized && resolvedEntity !== 'unknown' && isMutation) {
      try {
        return await window.SkyHonixOffline.offlineAPI.call(endpoint, method, body, {
          entity: resolvedEntity,
          entityId: extractEntityId(endpoint, body),
          isFormData
        });
      } catch (err) {
        // If offline engine error is about being offline, rethrow
        if (err.message.includes('offline') || err.message.includes('connection')) throw err;
        // Otherwise fall through to direct call for reads
        if (!isMutation) throw err;
      }
    }

    // Fallback: direct API call (original logic)
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
          lockOverlay.style.display = 'flex';
        } else {
          localStorage.removeItem('skyhonix_token');
          localStorage.removeItem('skyhonix_user');
          window.location.href = 'index.html';
        }
      }

      if (!response.ok) {
        throw new Error(result.error || 'API Request failed');
      }

      if (result.syncEvent) {
        await handleSyncEvent(result.syncEvent, result);
      }

      return result;
    } catch (err) {
      // Network failure on mutation: queue via offline engine
      if (isMutation && window.SkyHonixOffline && window.SkyHonixOffline._initialized && err.message.includes('Failed to fetch')) {
        return await window.SkyHonixOffline.offlineAPI._queueMutation(
          endpoint, method, body, resolveEntity(endpoint), extractEntityId(endpoint, body)
        );
      }

      console.error(`API Call failed (${endpoint}):`, err);
      showToast(err.message, true);
      throw err;
    }
  }

  // Resolve entity type from endpoint
  function resolveEntity(endpoint) {
    const path = endpoint.split('?')[0];
    if (path.includes('/students')) return 'student';
    if (path.includes('/attendance')) return 'attendance';
    if (path.includes('/fees/pay')) return 'fee';
    if (path.includes('/fees/setup')) return 'fee_setup';
    if (path.includes('/fees/dues')) return 'fee_dues';
    if (path.includes('/fees/ledger')) return 'fee';
    if (path.includes('/exams/marks')) return 'marks';
    if (path.includes('/exams/subjects')) return 'exam_subject';
    if (path.includes('/exams')) return 'exam';
    if (path.includes('/staff/teachers')) return 'teacher';
    if (path.includes('/staff/announcements')) return 'announcement';
    if (path.includes('/staff/parents')) return 'parent';
    if (path.includes('/teachers/assignments')) return 'assignment';
    if (path.includes('/teachers/my-marks')) return 'marks';
    if (path.includes('/teachers/fee-pay')) return 'fee';
    if (path.includes('/settings')) return 'settings';
    if (path.includes('/transport/vehicles')) return 'vehicle';
    if (path.includes('/transport/drivers')) return 'driver';
    if (path.includes('/transport/routes')) return 'route';
    return 'unknown';
  }

  function extractEntityId(endpoint, body) {
    const parts = endpoint.split('?')[0].split('/');
    const last = parts[parts.length - 1];
    if (last && !isNaN(last)) return last;
    if (body && body.student_id) return body.student_id;
    if (body && body.teacher_id) return body.teacher_id;
    if (body && body.id) return body.id;
    return 'local_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
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
          const monthlyRate = data.school.subscription_amount || 1500;
          const lockReason = document.getElementById('lock-reason-text');
          if (lockReason) {
            if (sub === 'pending') {
              lockReason.innerHTML = `Your school registration is <strong>pending admin approval</strong> (${data.school.selected_package || 'No package'} at <strong>${monthlyRate.toLocaleString()} PKR/month</strong>). Please upload a payment receipt below, or wait for admin activation.`;
            } else {
              lockReason.innerHTML = `Your school subscription is <strong>suspended or overdue</strong>. Billed at <strong>${monthlyRate.toLocaleString()} PKR monthly</strong>. Please upload your payment transfer receipt to restore full system access.`;
            }
          }
          const lockPayAmount = document.getElementById('lock-pay-amount');
          if (lockPayAmount) lockPayAmount.value = monthlyRate;
          const codeEl = document.getElementById('lock-school-code-display');
          if (codeEl) {
            const code = data.school.school_code;
            codeEl.innerHTML = code
              ? `Your Unique School ID: <strong>${code}</strong>`
              : `<span style="color:#f59e0b;">School ID: Waiting for admin to assign</span>`;
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
      loadClassesList().then(() => loadStudentsList());
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
    } else if (screenName === 'promotions') {
      loadPromotionsData();
      resetPromoPanels();
    } else if (screenName === 'principal-management') {
      loadPrincipalManagement();
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
      const stats = await apiCall('/dashboard/stats');

      document.getElementById('stat-total-students').innerText = stats.totalStudents || 0;

      let presentCount = 0;
      let totalAttLogs = 0;
      (stats.attendanceStats || []).forEach(s => {
        if (s.status === 'Present') presentCount = s.count;
        totalAttLogs += s.count;
      });

      const rate = totalAttLogs > 0 ? Math.round((presentCount / totalAttLogs) * 100) : 0;
      document.getElementById('stat-attendance-rate').innerText = totalAttLogs > 0 ? `${rate}%` : '0%';

      document.getElementById('stat-month-fees').innerText = `${(stats.monthCollected || 0).toLocaleString()} PKR`;
      document.getElementById('stat-pending-dues').innerText = `${(stats.pendingDues || 0).toLocaleString()} PKR`;

      document.getElementById('dash-school-title').innerText = (stats.settings && stats.settings.school_name) || '';
      document.getElementById('dash-school-phone').innerText = (stats.settings && stats.settings.phone) || 'N/A';
      document.getElementById('dash-school-reg').innerText = (stats.settings && stats.settings.registration_number) || 'N/A';
      document.getElementById('dash-school-id').innerText = currentUser.schoolId || 'N/A';
      if (stats.settings && stats.settings.logo_path) {
        document.getElementById('dash-school-logo').src = imgSrc(stats.settings.logo_path);
      }

    } catch (e) {
      console.error('Dashboard stats error:', e);
      document.getElementById('stat-total-students').innerText = '0';
      document.getElementById('stat-attendance-rate').innerText = '0%';
      document.getElementById('stat-month-fees').innerText = '0 PKR';
      document.getElementById('stat-pending-dues').innerText = '0 PKR';
    }
  }

  // Dashboard shortcuts
  document.getElementById('dash-btn-scan').addEventListener('click', () => {
    document.querySelector('[data-screen="attendance"]').click();
    document.querySelector('[data-tab="att-scan"]').click();
    document.getElementById('btn-start-scanner').click();
  });
  document.getElementById('dash-btn-fees').addEventListener('click', () => {
    document.querySelector('[data-screen="fees"]').click();
    document.querySelector('[data-tab="fee-generator"]').click();
  });

  // Dashboard Result Comparison
  async function loadDashboardExamDropdown() {
    try {
      const exams = await apiCall('/exams');
      const sel = document.getElementById('dash-compare-exam');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- Select Exam --</option>';
      exams.forEach(ex => {
        sel.innerHTML += `<option value="${ex.id}">${ex.exam_name} (${ex.year})</option>`;
      });
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  document.getElementById('dash-btn-load-comparison').addEventListener('click', async () => {
    const examId = document.getElementById('dash-compare-exam').value;
    const term = document.getElementById('dash-compare-term').value;
    if (!examId) { showToast('Please select an exam', true); return; }

    try {
      const data = await apiCall(`/exams/results/comparison?exam_id=${examId}&term=${encodeURIComponent(term)}`);
      const tbody = document.querySelector('#dash-compare-table tbody');
      const summary = document.getElementById('dash-compare-summary');

      if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 30px;">No result data found for this exam/term. Calculate results first.</td></tr>';
        summary.style.display = 'none';
        return;
      }

      // Summary
      summary.style.display = 'block';
      const totalStudents = data.reduce((s, c) => s + c.total_students, 0);
      const totalPassed = data.reduce((s, c) => s + c.passed, 0);
      const overallAvg = (data.reduce((s, c) => s + c.avg_percentage * c.total_students, 0) / totalStudents).toFixed(1);
      const overallPassRate = ((totalPassed / totalStudents) * 100).toFixed(1);
      const topClass = data.reduce((best, c) => c.avg_percentage > best.avg_percentage ? c : best, data[0]);

      document.getElementById('dash-compare-total-classes').textContent = data.length;
      document.getElementById('dash-compare-overall-avg').textContent = overallAvg + '%';
      document.getElementById('dash-compare-pass-rate').textContent = overallPassRate + '%';
      document.getElementById('dash-compare-top-class').textContent = topClass.class_name;

      // Table rows
      tbody.innerHTML = data.map(c => {
        const gradeBar = `
          <div style="display:flex; gap:2px; height:18px; border-radius:4px; overflow:hidden; min-width:120px;">
            ${c.grade_distribution.A ? `<div style="flex:${c.grade_distribution.A}; background:#059669;" title="A: ${c.grade_distribution.A}"></div>` : ''}
            ${c.grade_distribution.B ? `<div style="flex:${c.grade_distribution.B}; background:#2563EB;" title="B: ${c.grade_distribution.B}"></div>` : ''}
            ${c.grade_distribution.C ? `<div style="flex:${c.grade_distribution.C}; background:#D97706;" title="C: ${c.grade_distribution.C}"></div>` : ''}
            ${c.grade_distribution.D ? `<div style="flex:${c.grade_distribution.D}; background:#F97316;" title="D: ${c.grade_distribution.D}"></div>` : ''}
            ${c.grade_distribution.F ? `<div style="flex:${c.grade_distribution.F}; background:#DC2626;" title="F: ${c.grade_distribution.F}"></div>` : ''}
          </div>
          <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">A:${c.grade_distribution.A} B:${c.grade_distribution.B} C:${c.grade_distribution.C} D:${c.grade_distribution.D} F:${c.grade_distribution.F}</div>
        `;

        return `
          <tr>
            <td><strong>${c.class_name}</strong></td>
            <td>${c.total_students}</td>
            <td style="font-weight:600; color:${c.avg_percentage >= 60 ? 'var(--success)' : c.avg_percentage >= 40 ? 'var(--warning)' : 'var(--danger)'};">${c.avg_percentage}%</td>
            <td style="color:var(--success); font-weight:500;">${c.max_percentage}%</td>
            <td style="color:var(--danger); font-weight:500;">${c.min_percentage}%</td>
            <td style="font-weight:600;">${c.pass_rate}%</td>
            <td><span style="color:var(--success);">${c.passed}P</span> / <span style="color:var(--danger);">${c.failed}F</span></td>
            <td>${c.top_student ? `${c.top_student.name} (${c.top_student.percentage}%)` : '-'}</td>
            <td>${gradeBar}</td>
          </tr>
        `;
      }).join('');

    } catch (err) {
      showToast('Failed to load comparison: ' + err.message, true);
    }
  });

  // Load dashboard exam dropdown on screen switch
  const observer = new MutationObserver(() => {
    const dashScreen = document.getElementById('screen-dashboard');
    if (dashScreen && dashScreen.style.display !== 'none') {
      loadDashboardExamDropdown();
    }
  });
  const dashEl = document.getElementById('screen-dashboard');
  if (dashEl) observer.observe(dashEl, { attributes: true, attributeFilter: ['style'] });

  // ==========================================
  // MODULE: PROMOTE STUDENTS
  // ==========================================
  function loadPromotionsData() {
    loadPromoClasses();
    loadPromoHistory();
  }

  async function loadPromoClasses() {
    try {
      const classes = await apiCall('/promotions/classes');
      const promoClassCheckboxes = document.getElementById('promo-class-checkboxes');
      const promoLeaveClass = document.getElementById('promo-leave-class');

      if (promoClassCheckboxes) {
        promoClassCheckboxes.innerHTML = classes.map(c =>
          `<label style="display:flex; align-items:center; gap:6px; cursor:pointer; background: rgba(99,102,241,0.08); padding: 6px 12px; border-radius: 8px;">
            <input type="checkbox" class="promo-class-check" value="${c.class_name}">
            <span>${c.class_name} (${c.count})</span>
          </label>`
        ).join('');
      }

      if (promoLeaveClass) {
        promoLeaveClass.innerHTML = '<option value="">All Classes</option>' +
          classes.map(c => `<option value="${c.class_name}">${c.class_name} (${c.count})</option>`).join('');
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  async function loadPromoHistory() {
    try {
      const history = await apiCall('/promotions/history');
      const tbody = document.querySelector('#table-promo-history tbody');
      if (history.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No promotion history yet.</td></tr>';
        return;
      }
      tbody.innerHTML = history.map(h => `<tr>
        <td>${h.promotion_date ? new Date(h.promotion_date).toLocaleDateString() : '-'}</td>
        <td>${h.student_name || '-'}</td>
        <td>${h.from_class || '-'}</td>
        <td>${h.to_class || '-'}</td>
        <td>${h.final_percentage !== null ? h.final_percentage + '%' : '-'}</td>
        <td>${h.remarks || '-'}</td>
      </tr>`).join('');
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  async function loadPromoExams() {
    try {
      const exams = await apiCall('/exams');
      const selects = ['promo-school-exam', 'promo-class-exam'];
      selects.forEach(id => {
        const sel = document.getElementById(id);
        if (sel) {
          sel.innerHTML = '<option value="">-- Latest Result --</option>';
          exams.forEach(e => {
            sel.innerHTML += `<option value="${e.id}">${e.exam_name} (${e.year})</option>`;
          });
        }
      });
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  function resetPromoPanels() {
    const promoScreen = document.getElementById('screen-promotions');
    if (!promoScreen) return;
    document.getElementById('promo-main-view').style.display = '';
    document.getElementById('promo-panel-school-wide').style.display = 'none';
    document.getElementById('promo-panel-class-wise').style.display = 'none';
    document.getElementById('promo-panel-leave').style.display = 'none';
    document.getElementById('promo-school-preview-container').style.display = 'none';
    document.getElementById('promo-school-execute').style.display = 'none';
    document.getElementById('promo-class-preview-container').style.display = 'none';
    document.getElementById('promo-class-execute').style.display = 'none';
  }

  // Navigation: Promotion dash cards
  document.getElementById('promo-school-wise').addEventListener('click', () => {
    document.getElementById('promo-main-view').style.display = 'none';
    document.getElementById('promo-panel-school-wide').style.display = 'block';
    document.getElementById('promo-panel-class-wise').style.display = 'none';
    document.getElementById('promo-panel-leave').style.display = 'none';
    document.getElementById('promo-school-preview-container').style.display = 'none';
    document.getElementById('promo-school-execute').style.display = 'none';
    loadPromoExams();
  });

  document.getElementById('promo-class-wise').addEventListener('click', () => {
    document.getElementById('promo-main-view').style.display = 'none';
    document.getElementById('promo-panel-class-wise').style.display = 'block';
    document.getElementById('promo-panel-school-wide').style.display = 'none';
    document.getElementById('promo-panel-leave').style.display = 'none';
    document.getElementById('promo-class-preview-container').style.display = 'none';
    document.getElementById('promo-class-execute').style.display = 'none';
    loadPromoExams();
  });

  document.getElementById('promo-leave-students').addEventListener('click', () => {
    document.getElementById('promo-main-view').style.display = 'none';
    document.getElementById('promo-panel-leave').style.display = 'block';
    document.getElementById('promo-panel-school-wide').style.display = 'none';
    document.getElementById('promo-panel-class-wise').style.display = 'none';
    loadPromoClasses();
  });

  // Back buttons
  document.querySelectorAll('.btn-back-promo-dash').forEach(btn => {
    btn.addEventListener('click', () => {
      resetPromoPanels();
    });
  });

  // School Wide Preview
  document.getElementById('btn-promo-school-preview').addEventListener('click', async () => {
    const passing = document.getElementById('promo-school-passing').value;
    const examId = document.getElementById('promo-school-exam').value;
    const term = document.getElementById('promo-school-term').value;

    if (!passing && passing !== '0') {
      showToast('Please enter passing percentage', true);
      return;
    }

    try {
      let url = `/promotions/preview?passing_percent=${passing}&mode=school-wide`;
      if (examId) url += `&exam_id=${examId}&term=${term}`;

      const preview = await apiCall(url);
      const tbody = document.querySelector('#table-promo-school-preview tbody');
      const summary = document.getElementById('promo-school-summary');

      let totalPromote = 0, totalStay = 0, totalNoResult = 0;
      let rows = '';

      preview.forEach(cls => {
        if (!cls.students) return;
        cls.students.forEach(s => {
          const promoteClass = s.will_promote ? 'badge-green' : (s.status === 'FAIL' ? 'badge-red' : 'badge-yellow');
          if (s.will_promote) totalPromote++;
          else if (s.status === 'FAIL') totalStay++;
          else totalNoResult++;

          rows += `<tr>
            <td>${s.name}</td>
            <td>${s.roll_no || '-'}</td>
            <td>${cls.from}</td>
            <td>${s.will_promote ? cls.to : cls.from}</td>
            <td>${s.percentage !== null ? s.percentage.toFixed(1) + '%' : 'N/A'}</td>
            <td><span class="badge ${promoteClass}">${s.status}</span></td>
          </tr>`;
        });
      });

      summary.innerHTML = `
        <span style="color: var(--accent);">Total: ${totalPromote + totalStay + totalNoResult} students</span> |
        <span style="color: #22c55e;">Promote: ${totalPromote}</span> |
        <span style="color: #ef4444;">Stay (Fail): ${totalStay}</span> |
        <span style="color: #f59e0b;">No Result: ${totalNoResult}</span>
      `;
      tbody.innerHTML = rows || '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No students found.</td></tr>';
      document.getElementById('promo-school-preview-container').style.display = 'block';
      document.getElementById('promo-school-execute').style.display = 'inline-block';
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // School Wide Execute
  document.getElementById('btn-promo-school-execute').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to promote all passing students? This action cannot be undone.')) return;

    const passing = document.getElementById('promo-school-passing').value;
    const examId = document.getElementById('promo-school-exam').value;
    const term = document.getElementById('promo-school-term').value;

    try {
      const res = await apiCall('/promotions/school-wide', 'POST', {
        passing_percent: parseFloat(passing),
        exam_id: examId ? parseInt(examId) : null,
        term
      });
      showToast(res.message);
      document.getElementById('promo-school-preview-container').style.display = 'none';
      document.getElementById('promo-school-execute').style.display = 'none';
      loadPromoHistory();
      loadClassesList();
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // Class Wise Preview
  document.getElementById('btn-promo-class-preview').addEventListener('click', async () => {
    const passing = document.getElementById('promo-class-passing').value;
    const examId = document.getElementById('promo-class-exam').value;
    const term = document.getElementById('promo-class-term').value;
    const checked = [...document.querySelectorAll('.promo-class-check:checked')].map(cb => cb.value);

    if (!passing && passing !== '0') {
      showToast('Please enter passing percentage', true);
      return;
    }
    if (checked.length === 0) {
      showToast('Please select at least one class', true);
      return;
    }

    try {
      let url = `/promotions/preview?passing_percent=${passing}&mode=class-wise&class_names=${checked.join(',')}`;
      if (examId) url += `&exam_id=${examId}&term=${term}`;

      const preview = await apiCall(url);
      const tbody = document.querySelector('#table-promo-class-preview tbody');
      const summary = document.getElementById('promo-class-summary');

      let totalPromote = 0, totalStay = 0, totalNoResult = 0;
      let rows = '';

      preview.forEach(cls => {
        if (!cls.students) return;
        cls.students.forEach(s => {
          const promoteClass = s.will_promote ? 'badge-green' : (s.status === 'FAIL' ? 'badge-red' : 'badge-yellow');
          if (s.will_promote) totalPromote++;
          else if (s.status === 'FAIL') totalStay++;
          else totalNoResult++;

          rows += `<tr>
            <td>${s.name}</td>
            <td>${s.roll_no || '-'}</td>
            <td>${cls.from}</td>
            <td>${s.will_promote ? cls.to : cls.from}</td>
            <td>${s.percentage !== null ? s.percentage.toFixed(1) + '%' : 'N/A'}</td>
            <td><span class="badge ${promoteClass}">${s.status}</span></td>
          </tr>`;
        });
      });

      summary.innerHTML = `
        <span style="color: var(--accent);">Total: ${totalPromote + totalStay + totalNoResult} students</span> |
        <span style="color: #22c55e;">Promote: ${totalPromote}</span> |
        <span style="color: #ef4444;">Stay (Fail): ${totalStay}</span> |
        <span style="color: #f59e0b;">No Result: ${totalNoResult}</span>
      `;
      tbody.innerHTML = rows || '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No students found.</td></tr>';
      document.getElementById('promo-class-preview-container').style.display = 'block';
      document.getElementById('promo-class-execute').style.display = 'inline-block';
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // Class Wise Execute
  document.getElementById('btn-promo-class-execute').addEventListener('click', async () => {
    if (!confirm('Are you sure you want to promote selected classes? This action cannot be undone.')) return;

    const passing = document.getElementById('promo-class-passing').value;
    const examId = document.getElementById('promo-class-exam').value;
    const term = document.getElementById('promo-class-term').value;
    const checked = [...document.querySelectorAll('.promo-class-check:checked')].map(cb => cb.value);

    try {
      const res = await apiCall('/promotions/class-wise', 'POST', {
        passing_percent: parseFloat(passing),
        exam_id: examId ? parseInt(examId) : null,
        term,
        class_names: checked
      });
      showToast(res.message);
      document.getElementById('promo-class-preview-container').style.display = 'none';
      document.getElementById('promo-class-execute').style.display = 'none';
      loadPromoHistory();
      loadClassesList();
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // Leave Students: Load
  document.getElementById('btn-promo-leave-load').addEventListener('click', async () => {
    const cls = document.getElementById('promo-leave-class').value;
    const search = document.getElementById('promo-leave-search').value.trim();

    try {
      let url = '/students?';
      if (cls) url += `class_name=${encodeURIComponent(cls)}&`;
      if (search) url += `search=${encodeURIComponent(search)}&`;

      const students = await apiCall(url);
      const tbody = document.querySelector('#table-promo-leave tbody');
      const execBtn = document.getElementById('btn-promo-leave-execute');

      if (students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No active students found.</td></tr>';
        execBtn.style.display = 'none';
        return;
      }

      tbody.innerHTML = students.map(s => `
        <tr>
          <td><input type="checkbox" class="promo-leave-check" value="${s.id}"></td>
          <td>${s.student_id || '-'}</td>
          <td>${s.name}</td>
          <td>${s.father_name || '-'}</td>
          <td>${s.class_name} - ${s.section_name || 'N/A'}</td>
          <td>${s.roll_no || '-'}</td>
        </tr>
      `).join('');

      // Check all
      document.getElementById('promo-leave-check-all').addEventListener('change', function() {
        document.querySelectorAll('.promo-leave-check').forEach(cb => cb.checked = this.checked);
      });

      // Show execute button when any checkbox is checked
      document.querySelectorAll('.promo-leave-check').forEach(cb => {
        cb.addEventListener('change', () => {
          const anyChecked = document.querySelectorAll('.promo-leave-check:checked').length > 0;
          execBtn.style.display = anyChecked ? 'inline-block' : 'none';
        });
      });

      execBtn.style.display = 'none';
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // Leave Students: Execute
  document.getElementById('btn-promo-leave-execute').addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.promo-leave-check:checked')].map(cb => parseInt(cb.value));
    if (checked.length === 0) {
      showToast('No students selected', true);
      return;
    }

    if (!confirm(`Are you sure you want to mark ${checked.length} student(s) as Left?`)) return;

    try {
      const res = await apiCall('/promotions/leave', 'POST', { student_ids: checked });
      showToast(res.message);
      document.querySelector('#table-promo-leave tbody').innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted);">No students loaded.</td></tr>';
      document.getElementById('btn-promo-leave-execute').style.display = 'none';
      loadPromoClasses();
      loadClassesList();
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // ==========================================
  // MODULE: PRINCIPAL MANAGEMENT
  // ==========================================
  function loadPrincipalManagement() {
    resetPMpanels();
    loadPMTeachers();
  }

  function resetPMpanels() {
    const pmScreen = document.getElementById('screen-principal-management');
    if (!pmScreen) return;
    document.getElementById('pm-main-view').style.display = '';
    pmScreen.querySelectorAll('.fee-option-panel').forEach(p => p.style.display = 'none');
    document.getElementById('idcard-stu-info').style.display = 'none';
    document.getElementById('idcard-stu-preview-container').style.display = 'none';
    document.getElementById('idcard-teach-info').style.display = 'none';
    document.getElementById('idcard-teach-preview-container').style.display = 'none';
    document.getElementById('idcard-staff-preview-container').style.display = 'none';
    document.getElementById('idcard-cw-info').style.display = 'none';
    document.getElementById('idcard-cw-preview-container').style.display = 'none';
  }

  async function loadPMTeachers() {
    try {
      const teachers = await apiCall('/staff/teachers');
      const teachSelect = document.getElementById('idcard-teach-teacher');
      if (teachSelect) {
        teachSelect.innerHTML = '<option value="">-- Select Teacher --</option>';
        teachers.forEach(t => {
          teachSelect.innerHTML += `<option value="${t.id}">${t.name} (${t.subject || 'N/A'})</option>`;
        });
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // PM sub-panel navigation
  document.querySelectorAll('[data-opt^="pm-"]').forEach(card => {
    card.addEventListener('click', () => {
      if (card.style.opacity === '0.5') return; // Coming soon
      const opt = card.getAttribute('data-opt');
      document.getElementById('pm-main-view').style.display = 'none';
      const panel = document.getElementById('pm-panel-' + opt.replace('pm-', ''));
      if (panel) panel.style.display = 'block';
      if (opt === 'pm-idcard') loadPMIdCard();
      if (opt === 'pm-transport') loadTransportData();
      if (opt === 'pm-salary') loadSalarySetup();
    });
  });

  document.querySelectorAll('.btn-back-pm-dash').forEach(btn => {
    btn.addEventListener('click', () => resetPMpanels());
  });

  async function loadPMIdCard() {
    try {
      const classes = await apiCall('/students/classes');
      const classSelect = document.getElementById('idcard-stu-class');
      const cwClassSelect = document.getElementById('idcard-cw-class');
      if (classSelect) {
        classSelect.innerHTML = '<option value="">-- Select Class --</option>';
        classes.forEach(c => {
          const name = typeof c === 'object' ? c.class_name : c;
          classSelect.innerHTML += `<option value="${name}">${name}</option>`;
        });
      }
      if (cwClassSelect) {
        cwClassSelect.innerHTML = '<option value="">-- Select Class --</option>';
        classes.forEach(c => {
          const name = typeof c === 'object' ? c.class_name : c;
          cwClassSelect.innerHTML += `<option value="${name}">${name}</option>`;
        });
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // Student ID Card: class change loads students
  document.getElementById('idcard-stu-class').addEventListener('change', async function() {
    const className = this.value;
    const studentSelect = document.getElementById('idcard-stu-student');
    studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
    studentSelect.disabled = true;
    document.getElementById('btn-idcard-stu-generate').disabled = true;
    document.getElementById('idcard-stu-info').style.display = 'none';
    document.getElementById('idcard-stu-preview-container').style.display = 'none';

    if (!className) return;
    try {
      const students = await apiCall(`/students?class_name=${encodeURIComponent(className)}`);
      studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
      students.forEach(s => {
        studentSelect.innerHTML += `<option value="${s.id}">${s.roll_no || '-'} - ${s.name}</option>`;
      });
      studentSelect.disabled = false;
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // Student ID Card: student change loads info
  document.getElementById('idcard-stu-student').addEventListener('change', async function() {
    const studentId = this.value;
    document.getElementById('btn-idcard-stu-generate').disabled = true;
    document.getElementById('idcard-stu-info').style.display = 'none';
    document.getElementById('idcard-stu-preview-container').style.display = 'none';

    if (!studentId) return;
    try {
      const data = await apiCall(`/students/${studentId}`);
      const s = data.student;
      document.getElementById('idcard-stu-name').textContent = s.name || '-';
      document.getElementById('idcard-stu-father').textContent = s.father_name || '-';
      document.getElementById('idcard-stu-id').textContent = s.student_id || '-';
      document.getElementById('idcard-stu-classname').textContent = s.class_name || '-';
      document.getElementById('idcard-stu-roll').textContent = s.roll_no || '-';
      document.getElementById('idcard-stu-phone').textContent = s.phone || '-';
      document.getElementById('idcard-stu-dob').textContent = s.dob || '-';
      document.getElementById('idcard-stu-gender').textContent = s.gender || '-';
      document.getElementById('idcard-stu-admno').textContent = s.admission_no || '-';
      document.getElementById('idcard-stu-info').style.display = 'block';
      document.getElementById('btn-idcard-stu-generate').disabled = false;

      // Store student data for card generation
      document.getElementById('idcard-stu-student').dataset.studentData = JSON.stringify(s);
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // Teacher ID Card: teacher change loads info
  document.getElementById('idcard-teach-teacher').addEventListener('change', async function() {
    const teacherId = this.value;
    document.getElementById('btn-idcard-teach-generate').disabled = true;
    document.getElementById('idcard-teach-info').style.display = 'none';
    document.getElementById('idcard-teach-preview-container').style.display = 'none';

    if (!teacherId) return;
    try {
      const teachers = await apiCall('/staff/teachers');
      const t = teachers.find(te => te.id == teacherId);
      if (!t) return;
      document.getElementById('idcard-teach-name').textContent = t.name || '-';
      document.getElementById('idcard-teach-phone').textContent = t.phone || '-';
      document.getElementById('idcard-teach-subject').textContent = t.subject || '-';
      document.getElementById('idcard-teach-qual').textContent = t.qualification || '-';
      document.getElementById('idcard-teach-status').textContent = t.status || '-';
      document.getElementById('idcard-teach-info').style.display = 'block';
      document.getElementById('btn-idcard-teach-generate').disabled = false;
      document.getElementById('idcard-teach-teacher').dataset.teacherData = JSON.stringify(t);
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // ID Card design themes
  const idCardThemes = {
    design1:   { bg: '#1565c0', headerBg: '#0d47a1', accent: '#ffc107', label: 'Lanyard Badge (Design 1)' },
    classic:    { bg: '#1e3a8a', headerBg: '#1e40af', accent: '#60a5fa', label: 'Classic Landscape' },
    portrait:   { bg: '#0f172a', headerBg: '#1e293b', accent: '#38bdf8', label: 'Portrait Vertical' },
    badge:      { bg: '#ffffff', headerBg: '#dc2626', accent: '#dc2626', label: 'Badge / Lanyard' },
    twosided:   { bg: '#1e293b', headerBg: '#0f172a', accent: '#a78bfa', label: 'Two-Sided Card' },
    smart:      { bg: '#f8fafc', headerBg: '#1e40af', accent: '#1e40af', label: 'Smart Chip Card' },
    pakistani:  { bg: '#006233', headerBg: '#006233', accent: '#fff', label: 'Pakistani Green' },
    kids:       { bg: '#f0abfc', headerBg: '#a855f7', accent: '#f472b6', label: 'Kids / Primary' },
    corporate:  { bg: '#f1f5f9', headerBg: '#334155', accent: '#0ea5e9', label: 'Corporate Clean' }
  };

  function generateIdCardHtml(student, design, schoolName, logoPath, includeQr, includeBarcode, principalSign) {
    const d = design || 'classic';
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=80x80&data=${encodeURIComponent(student.student_id || student.name || '')}`;
    const photoSrc = student.photo ? imgSrc(student.photo, 'school_assets/school_logo.png') : 'school_assets/school_logo.png';
    const logoSrc = logoPath ? imgSrc(logoPath, 'school_assets/school_logo.png') : 'school_assets/school_logo.png';
    const year = new Date().getFullYear();
    const s = student;
    const cls = s.class_name || '-';
    const barcode = includeBarcode ? `<div style="text-align:center;margin-top:4px;"><div style="font-family:monospace;font-size:0.65rem;letter-spacing:2px;background:#fff;padding:3px 8px;border-radius:3px;color:#000;display:inline-block;border:1px solid #ddd;">║║ ${s.student_id||s.id||'00000'} ║║</div></div>` : '';
    const qr = includeQr ? `<div style="margin-top:6px;"><img src="${qrUrl}" style="width:65px;height:65px;border-radius:4px;" onerror="this.style.display='none'"></div>` : '';
    const principalSignImg = principalSign ? `<img src="${principalSign}" style="height:28px;max-width:80px;object-fit:contain;" onerror="this.style.display='none'">` : '';

    if (d === 'classic') {
      return `<div style="width:340px;height:215px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.25);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fff;display:flex;flex-direction:column;">
        <div style="background:#1e40af;padding:8px 16px;display:flex;align-items:center;gap:10px;">
          <img src="${logoSrc}" style="height:32px;border-radius:4px;" onerror="this.style.display='none'">
          <div style="font-size:0.85rem;font-weight:800;color:#fff;flex:1;">${schoolName||'SCHOOL'}</div>
          <div style="font-size:0.55rem;color:rgba(255,255,255,0.7);text-align:right;">Student Card<br>${year}</div>
        </div>
        <div style="flex:1;display:flex;padding:10px 14px;gap:12px;">
          <div style="flex-shrink:0;text-align:center;">
            <img src="${photoSrc}" style="width:72px;height:82px;border-radius:6px;object-fit:cover;border:2px solid #60a5fa;" onerror="this.src='school_assets/school_logo.png'">
            ${qr}
          </div>
          <div style="flex:1;font-size:0.78rem;color:#1e293b;">
            <div style="font-size:1rem;font-weight:700;margin-bottom:2px;">${s.name||'-'}</div>
            <div style="font-size:0.68rem;color:#64748b;margin-bottom:6px;">S/O ${s.father_name||'-'}</div>
            <table style="width:100%;border-collapse:collapse;font-size:0.72rem;">
              <tr><td style="padding:1.5px 0;color:#94a3b8;width:50px;">ID</td><td style="padding:1.5px 0;font-weight:600;">${s.student_id||'-'}</td><td style="padding:1.5px 0;color:#94a3b8;width:38px;">Class</td><td style="padding:1.5px 0;font-weight:600;">${cls}</td></tr>
              <tr><td style="padding:1.5px 0;color:#94a3b8;">Roll</td><td style="padding:1.5px 0;font-weight:600;">${s.roll_no||'-'}</td><td style="padding:1.5px 0;color:#94a3b8;">DOB</td><td style="padding:1.5px 0;font-weight:600;">${s.dob||'-'}</td></tr>
              <tr><td style="padding:1.5px 0;color:#94a3b8;">Ph</td><td style="padding:1.5px 0;font-weight:600;" colspan="3">${s.phone||'-'}</td></tr>
            </table>
            ${barcode}
          </div>
        </div>
      </div>`;
    }

    if (d === 'portrait') {
      return `<div style="width:220px;height:340px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.25);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fff;display:flex;flex-direction:column;">
        <div style="background:#1e293b;padding:10px;text-align:center;">
          <img src="${logoSrc}" style="height:30px;border-radius:4px;" onerror="this.style.display='none'">
          <div style="font-size:0.75rem;font-weight:800;color:#fff;margin-top:4px;">${schoolName||'SCHOOL'}</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;padding:12px 14px;">
          <img src="${photoSrc}" style="width:80px;height:90px;border-radius:8px;object-fit:cover;border:3px solid #38bdf8;margin-bottom:8px;" onerror="this.src='school_assets/school_logo.png'">
          <div style="text-align:center;width:100%;">
            <div style="font-size:0.9rem;font-weight:700;color:#1e293b;">${s.name||'-'}</div>
            <div style="font-size:0.65rem;color:#64748b;margin-bottom:8px;">S/O ${s.father_name||'-'}</div>
            <div style="background:#f1f5f9;border-radius:6px;padding:6px 8px;text-align:left;font-size:0.7rem;">
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">ID</span><strong>${s.student_id||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">Class</span><strong>${cls}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">Roll</span><strong>${s.roll_no||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">Phone</span><strong>${s.phone||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">DOB</span><strong>${s.dob||'-'}</strong></div>
            </div>
            ${qr}
          </div>
        </div>
        <div style="background:#f1f5f9;padding:6px;text-align:center;font-size:0.55rem;color:#94a3b8;border-top:1px solid #e2e8f0;">Valid ${year} | Principal</div>
      </div>`;
    }

    if (d === 'badge') {
      return `<div style="width:240px;height:340px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.2);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fff;display:flex;flex-direction:column;border:2px solid #e2e8f0;">
        <div style="text-align:center;padding-top:10px;">
          <div style="width:24px;height:24px;border-radius:50%;border:3px solid #cbd5e1;margin:0 auto;background:#f8fafc;"></div>
        </div>
        <div style="background:#dc2626;margin:8px 12px 0;border-radius:8px;padding:10px;text-align:center;">
          <img src="${logoSrc}" style="height:34px;border-radius:6px;" onerror="this.style.display='none'">
          <div style="font-size:0.8rem;font-weight:800;color:#fff;margin-top:4px;">${schoolName||'SCHOOL'}</div>
        </div>
        <div style="flex:1;display:flex;flex-direction:column;align-items:center;padding:12px 16px;">
          <img src="${photoSrc}" style="width:80px;height:90px;border-radius:50%;object-fit:cover;border:3px solid #dc2626;margin-bottom:8px;" onerror="this.src='school_assets/school_logo.png'">
          <div style="text-align:center;width:100%;">
            <div style="font-size:0.88rem;font-weight:700;color:#1e293b;">${s.name||'-'}</div>
            <div style="font-size:0.65rem;color:#64748b;">S/O ${s.father_name||'-'}</div>
            <div style="margin-top:8px;border-top:2px solid #dc2626;padding-top:8px;font-size:0.7rem;color:#475569;">
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">Class</span><strong>${cls}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">Roll</span><strong>${s.roll_no||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">ID</span><strong>${s.student_id||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#94a3b8;">Phone</span><strong>${s.phone||'-'}</strong></div>
            </div>
            ${qr}
          </div>
        </div>
        <div style="background:#fef2f2;padding:6px;text-align:center;font-size:0.55rem;color:#dc2626;font-weight:600;">EMERGENCY: ${s.phone||'N/A'}</div>
      </div>`;
    }

    if (d === 'twosided') {
      return `<div style="display:flex;gap:10px;flex-shrink:0;">
        <div style="width:340px;height:215px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.25);font-family:'Segoe UI',Arial,sans-serif;background:#1e293b;display:flex;flex-direction:column;">
          <div style="background:#0f172a;padding:8px 14px;display:flex;align-items:center;gap:8px;">
            <img src="${logoSrc}" style="height:28px;border-radius:4px;" onerror="this.style.display='none'">
            <div style="font-size:0.8rem;font-weight:800;color:#fff;">${schoolName||'SCHOOL'}</div>
          </div>
          <div style="flex:1;display:flex;padding:10px;gap:10px;">
            <img src="${photoSrc}" style="width:80px;height:90px;border-radius:8px;object-fit:cover;border:2px solid #a78bfa;flex-shrink:0;" onerror="this.src='school_assets/school_logo.png'">
            <div style="flex:1;color:#fff;font-size:0.78rem;">
              <div style="font-size:0.95rem;font-weight:700;">${s.name||'-'}</div>
              <div style="font-size:0.65rem;color:rgba(255,255,255,0.6);">S/O ${s.father_name||'-'}</div>
              <div style="margin-top:6px;font-size:0.72rem;">
                <div><span style="opacity:0.6;">Class:</span> <strong>${cls}</strong></div>
                <div><span style="opacity:0.6;">Roll:</span> <strong>${s.roll_no||'-'}</strong></div>
                <div><span style="opacity:0.6;">ID:</span> <strong>${s.student_id||'-'}</strong></div>
              </div>
              ${qr}
            </div>
          </div>
          <div style="text-align:center;padding:4px;font-size:0.5rem;color:rgba(255,255,255,0.5);">FRONT SIDE</div>
        </div>
        <div style="width:340px;height:215px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.25);font-family:'Segoe UI',Arial,sans-serif;background:#fff;display:flex;flex-direction:column;">
          <div style="background:#334155;padding:8px 14px;font-size:0.75rem;font-weight:700;color:#fff;text-align:center;">BACK SIDE</div>
          <div style="flex:1;padding:12px 16px;font-size:0.72rem;color:#475569;">
            <div style="text-align:center;margin-bottom:8px;"><div style="font-size:0.85rem;font-weight:700;color:#1e293b;">${schoolName||'SCHOOL'}</div><div style="font-size:0.6rem;color:#94a3b8;">Academic Year ${year}</div></div>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:3px 0;color:#94a3b8;width:80px;">Student ID</td><td style="padding:3px 0;font-weight:600;">${s.student_id||'-'}</td></tr>
              <tr><td style="padding:3px 0;color:#94a3b8;">Class / Section</td><td style="padding:3px 0;font-weight:600;">${cls}</td></tr>
              <tr><td style="padding:3px 0;color:#94a3b8;">Roll Number</td><td style="padding:3px 0;font-weight:600;">${s.roll_no||'-'}</td></tr>
              <tr><td style="padding:3px 0;color:#94a3b8;">Date of Birth</td><td style="padding:3px 0;font-weight:600;">${s.dob||'-'}</td></tr>
              <tr><td style="padding:3px 0;color:#94a3b8;">Phone</td><td style="padding:3px 0;font-weight:600;">${s.phone||'-'}</td></tr>
              <tr><td style="padding:3px 0;color:#94a3b8;">Gender</td><td style="padding:3px 0;font-weight:600;">${s.gender||'-'}</td></tr>
            </table>
            <div style="margin-top:8px;display:flex;justify-content:space-between;">
              <div style="text-align:center;"><div style="height:1px;width:80px;background:#cbd5e1;margin:0 auto 2px;"></div><div style="font-size:0.55rem;color:#94a3b8;">Principal</div></div>
              <div style="text-align:center;"><div style="height:1px;width:80px;background:#cbd5e1;margin:0 auto 2px;"></div><div style="font-size:0.55rem;color:#94a3b8;">Class Teacher</div></div>
            </div>
          </div>
        </div>
      </div>`;
    }

    if (d === 'smart') {
      return `<div style="width:340px;height:215px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.15);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fff;display:flex;flex-direction:column;border:1px solid #e2e8f0;">
        <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);padding:10px 16px;display:flex;align-items:center;gap:10px;">
          <img src="${logoSrc}" style="height:30px;border-radius:4px;" onerror="this.style.display='none'">
          <div style="flex:1;"><div style="font-size:0.8rem;font-weight:800;color:#fff;">${schoolName||'SCHOOL'}</div><div style="font-size:0.55rem;color:rgba(255,255,255,0.7);">Student Identity Card</div></div>
          <div style="width:32px;height:24px;background:linear-gradient(135deg,#fbbf24,#f59e0b);border-radius:4px;border:1px solid #d97706;position:relative;">
            <div style="position:absolute;top:5px;left:4px;right:4px;height:1px;background:#92400e;"></div>
            <div style="position:absolute;top:10px;left:4px;right:4px;height:1px;background:#92400e;"></div>
            <div style="position:absolute;top:15px;left:4px;right:4px;height:1px;background:#92400e;"></div>
          </div>
        </div>
        <div style="flex:1;display:flex;padding:10px 14px;gap:12px;">
          <div style="flex-shrink:0;">
            <img src="${photoSrc}" style="width:75px;height:85px;border-radius:6px;object-fit:cover;border:2px solid #e2e8f0;" onerror="this.src='school_assets/school_logo.png'">
          </div>
          <div style="flex:1;font-size:0.78rem;color:#1e293b;">
            <div style="font-size:0.95rem;font-weight:700;">${s.name||'-'}</div>
            <div style="font-size:0.65rem;color:#64748b;margin-bottom:6px;">S/O ${s.father_name||'-'}</div>
            <div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:2px 6px;font-size:0.7rem;">
              <span style="color:#94a3b8;">ID</span><strong>${s.student_id||'-'}</strong>
              <span style="color:#94a3b8;">Class</span><strong>${cls}</strong>
              <span style="color:#94a3b8;">Roll</span><strong>${s.roll_no||'-'}</strong>
              <span style="color:#94a3b8;">DOB</span><strong>${s.dob||'-'}</strong>
            </div>
            <div style="margin-top:4px;display:flex;gap:8px;align-items:center;">${qr}${barcode}</div>
          </div>
        </div>
        <div style="background:#f1f5f9;padding:4px 14px;display:flex;justify-content:space-between;font-size:0.5rem;color:#94a3b8;border-top:1px solid #e2e8f0;">
          <span>VALID: ${year}</span><span>${s.student_id||'N/A'}</span><span>SCHOOL ID CARD</span>
        </div>
      </div>`;
    }

    if (d === 'pakistani') {
      return `<div style="width:340px;height:215px;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.25);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fff;display:flex;flex-direction:column;">
        <div style="background:#006233;padding:10px 16px;display:flex;align-items:center;gap:10px;position:relative;">
          <div style="position:absolute;right:12px;top:50%;transform:translateY(-50%);opacity:0.15;font-size:2.5rem;">&#9770;</div>
          <img src="${logoSrc}" style="height:32px;border-radius:4px;border:1px solid rgba(255,255,255,0.3);" onerror="this.style.display='none'">
          <div style="font-size:0.82rem;font-weight:800;color:#fff;">${schoolName||'SCHOOL'}</div>
        </div>
        <div style="height:3px;background:linear-gradient(90deg,#fff 33%,#006233 33%,#006233 66%,#fff 66%);"></div>
        <div style="flex:1;display:flex;padding:10px 14px;gap:12px;">
          <div style="flex-shrink:0;text-align:center;">
            <img src="${photoSrc}" style="width:75px;height:85px;border-radius:6px;object-fit:cover;border:3px solid #006233;" onerror="this.src='school_assets/school_logo.png'">
            ${qr}
          </div>
          <div style="flex:1;font-size:0.78rem;color:#1e293b;">
            <div style="font-size:0.95rem;font-weight:700;color:#006233;">${s.name||'-'}</div>
            <div style="font-size:0.65rem;color:#64748b;margin-bottom:6px;">S/O ${s.father_name||'-'}</div>
            <table style="width:100%;border-collapse:collapse;font-size:0.72rem;">
              <tr><td style="padding:2px 0;color:#006233;width:55px;font-weight:600;">ID No</td><td style="padding:2px 0;">${s.student_id||'-'}</td></tr>
              <tr><td style="padding:2px 0;color:#006233;font-weight:600;">Class</td><td style="padding:2px 0;">${cls}</td></tr>
              <tr><td style="padding:2px 0;color:#006233;font-weight:600;">Roll</td><td style="padding:2px 0;">${s.roll_no||'-'}</td></tr>
              <tr><td style="padding:2px 0;color:#006233;font-weight:600;">Phone</td><td style="padding:2px 0;">${s.phone||'-'}</td></tr>
            </table>
            ${barcode}
          </div>
        </div>
        <div style="background:#006233;padding:5px 14px;display:flex;justify-content:space-between;align-items:center;">
          <div style="font-size:0.55rem;color:rgba(255,255,255,0.7);">Pakistan Zindabad</div>
          <div style="font-size:0.55rem;color:rgba(255,255,255,0.7);">Valid ${year}</div>
        </div>
      </div>`;
    }

    if (d === 'kids') {
      return `<div style="width:340px;height:225px;border-radius:18px;overflow:hidden;box-shadow:0 6px 24px rgba(168,85,247,0.25);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fdf4ff;display:flex;flex-direction:column;border:3px solid #e9d5ff;">
        <div style="background:linear-gradient(135deg,#a855f7,#ec4899);padding:10px 16px;display:flex;align-items:center;gap:10px;">
          <img src="${logoSrc}" style="height:34px;border-radius:10px;border:2px solid rgba(255,255,255,0.4);" onerror="this.style.display='none'">
          <div style="font-size:0.85rem;font-weight:800;color:#fff;">${schoolName||'SCHOOL'}</div>
          <div style="margin-left:auto;font-size:1.4rem;">&#127891;</div>
        </div>
        <div style="flex:1;display:flex;padding:12px 16px;gap:14px;">
          <div style="flex-shrink:0;">
            <img src="${photoSrc}" style="width:78px;height:88px;border-radius:14px;object-fit:cover;border:3px solid #c084fc;background:#fff;" onerror="this.src='school_assets/school_logo.png'">
            ${qr}
          </div>
          <div style="flex:1;font-size:0.78rem;color:#1e293b;">
            <div style="font-size:1rem;font-weight:700;color:#7c3aed;">${s.name||'-'}</div>
            <div style="font-size:0.65rem;color:#94a3b8;margin-bottom:6px;">S/O ${s.father_name||'-'}</div>
            <div style="background:#f3e8ff;border-radius:10px;padding:6px 10px;font-size:0.72rem;">
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#a855f7;">Class</span><strong>${cls}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#a855f7;">Roll</span><strong>${s.roll_no||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#a855f7;">ID</span><strong>${s.student_id||'-'}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:2px 0;"><span style="color:#a855f7;">Phone</span><strong>${s.phone||'-'}</strong></div>
            </div>
            ${barcode}
          </div>
        </div>
      </div>`;
    }

    if (d === 'corporate') {
      return `<div style="width:340px;height:215px;border-radius:4px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.1);font-family:'Segoe UI',Arial,sans-serif;flex-shrink:0;background:#fff;display:flex;border:1px solid #e2e8f0;">
        <div style="width:95px;background:#f8fafc;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px;border-right:2px solid #e2e8f0;">
          <img src="${photoSrc}" style="width:70px;height:80px;border-radius:4px;object-fit:cover;margin-bottom:6px;" onerror="this.src='school_assets/school_logo.png'">
          ${qr}
        </div>
        <div style="flex:1;display:flex;flex-direction:column;">
          <div style="background:#334155;padding:6px 14px;display:flex;align-items:center;gap:8px;">
            <img src="${logoSrc}" style="height:22px;border-radius:3px;" onerror="this.style.display='none'">
            <div style="font-size:0.72rem;font-weight:700;color:#fff;">${schoolName||'SCHOOL'}</div>
            <div style="margin-left:auto;font-size:0.5rem;color:#94a3b8;">${year}</div>
          </div>
          <div style="flex:1;padding:8px 14px;font-size:0.75rem;color:#1e293b;">
            <div style="font-size:0.92rem;font-weight:700;">${s.name||'-'}</div>
            <div style="font-size:0.62rem;color:#64748b;margin-bottom:4px;">S/O ${s.father_name||'-'}</div>
            <div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:1px 8px;font-size:0.68rem;">
              <span style="color:#94a3b8;">ID</span><strong>${s.student_id||'-'}</strong>
              <span style="color:#94a3b8;">Class</span><strong>${cls}</strong>
              <span style="color:#94a3b8;">Roll</span><strong>${s.roll_no||'-'}</strong>
              <span style="color:#94a3b8;">DOB</span><strong>${s.dob||'-'}</strong>
            </div>
            ${barcode}
          </div>
          <div style="border-top:1px solid #e2e8f0;padding:4px 14px;display:flex;justify-content:space-between;font-size:0.5rem;color:#94a3b8;">
            <span>VALID: ${year}</span><span>PRINCIPAL SIGNATURE</span>
          </div>
        </div>
      </div>`;
    }

    if (d === 'design1') {
      const cardW = '3.375in', cardH = '2.125in';
      const backQr = includeQr ? `<img src="${qrUrl}" style="width:0.7in;height:0.7in;border-radius:3px;" onerror="this.style.display='none'">` : '';
      const backBarcode = includeBarcode ? `<div style="margin-top:4px;font-family:monospace;font-size:0.55rem;letter-spacing:2px;background:#fff;padding:3px 8px;border-radius:3px;color:#333;display:inline-block;border:1px solid #ddd;">║║ ${s.student_id||s.id||'00000'} ║║</div>` : '';
      const principalImg = principalSign ? `<img src="${principalSign}" style="height:20px;max-width:60px;object-fit:contain;" onerror="this.style.display='none'">` : `<div style="height:20px;"></div>`;

      return `<div style="display:flex;gap:16px;flex-shrink:0;align-items:flex-start;">
        <div style="width:${cardW};height:${cardH};border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.2);font-family:'Segoe UI',Arial,sans-serif;background:#fff;position:relative;display:flex;flex-direction:column;">
          <div style="background:linear-gradient(135deg,#1565c0 0%,#1976d2 50%,#1e88e5 100%);padding:6px 10px;display:flex;align-items:center;gap:6px;">
            <img src="${logoSrc}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,0.4);background:#fff;" onerror="this.src='school_assets/school_logo.png'">
            <div style="flex:1;">
              <div style="font-size:0.62rem;font-weight:800;color:#fff;letter-spacing:0.5px;text-transform:uppercase;line-height:1.1;">${schoolName||'SCHOOL NAME'}</div>
              <div style="font-size:0.4rem;color:rgba(255,255,255,0.7);margin-top:1px;">School Address Here</div>
            </div>
          </div>
          <div style="flex:1;display:flex;padding:5px 8px;gap:6px;">
            <div style="flex-shrink:0;display:flex;flex-direction:column;align-items:center;">
              <img src="${photoSrc}" style="width:0.85in;height:1in;border-radius:4px;object-fit:cover;border:2px solid #1565c0;background:#e3f2fd;" onerror="this.src='school_assets/school_logo.png'">
            </div>
            <div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;font-size:0.55rem;color:#1e293b;">
              <div style="font-weight:700;font-size:0.68rem;color:#0d47a1;line-height:1.1;">${s.name||'-'}</div>
              <div style="font-size:0.48rem;color:#64748b;">S/O ${s.father_name||'-'}</div>
              <table style="width:100%;border-collapse:collapse;font-size:0.5rem;">
                <tr><td style="padding:1px 0;color:#94a3b8;width:38px;">ID</td><td style="padding:1px 0;font-weight:600;">${s.student_id||'-'}</td><td style="padding:1px 0;color:#94a3b8;width:32px;">Class</td><td style="padding:1px 0;font-weight:600;">${cls}</td></tr>
                <tr><td style="padding:1px 0;color:#94a3b8;">Roll</td><td style="padding:1px 0;font-weight:600;">${s.roll_no||'-'}</td><td style="padding:1px 0;color:#94a3b8;">DOB</td><td style="padding:1px 0;font-weight:600;">${s.dob||'-'}</td></tr>
                <tr><td style="padding:1px 0;color:#94a3b8;">Ph.</td><td style="padding:1px 0;font-weight:600;" colspan="3">${s.phone||'-'}</td></tr>
              </table>
              <div style="display:flex;justify-content:flex-end;align-items:center;gap:4px;margin-top:2px;">
                <div style="text-align:right;"><div style="height:1px;width:45px;background:#bbb;margin:0 0 1px auto;"></div><div style="font-size:0.38rem;color:#888;">Principal</div></div>
                ${principalImg}
              </div>
            </div>
          </div>
          <div style="background:linear-gradient(135deg,#ffc107,#ffb300);padding:2px 10px;display:flex;justify-content:space-between;align-items:center;">
            <div style="font-size:0.38rem;color:#333;font-weight:600;">VALID: ${year}</div>
            <div style="font-size:0.38rem;color:#333;font-weight:700;letter-spacing:1px;">STUDENT ID CARD</div>
          </div>
        </div>
        <div style="width:${cardW};height:${cardH};border-radius:8px;overflow:hidden;box-shadow:0 4px 16px rgba(0,0,0,0.2);font-family:'Segoe UI',Arial,sans-serif;background:#f8f9fa;position:relative;display:flex;flex-direction:column;">
          <div style="background:linear-gradient(135deg,#1565c0 0%,#1976d2 50%,#1e88e5 100%);padding:5px 10px;text-align:center;">
            <div style="font-size:0.58rem;font-weight:800;color:#fff;letter-spacing:0.5px;">${schoolName||'SCHOOL NAME'}</div>
            <div style="font-size:0.38rem;color:rgba(255,255,255,0.7);">Academic Year ${year}</div>
          </div>
          <div style="flex:1;padding:5px 8px;display:flex;flex-direction:column;justify-content:space-between;">
            <div style="display:flex;gap:6px;align-items:flex-start;">
              <div style="flex-shrink:0;">${backQr}</div>
              <div style="flex:1;background:#fff;border-radius:4px;padding:4px 6px;font-size:0.48rem;color:#333;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
                <div style="display:flex;padding:1.5px 0;border-bottom:1px dotted #e0e0e0;"><span style="width:52px;color:#94a3b8;font-weight:600;">Student ID</span><span>: ${s.student_id||'-'}</span></div>
                <div style="display:flex;padding:1.5px 0;border-bottom:1px dotted #e0e0e0;"><span style="width:52px;color:#94a3b8;font-weight:600;">Class</span><span>: ${cls}</span></div>
                <div style="display:flex;padding:1.5px 0;border-bottom:1px dotted #e0e0e0;"><span style="width:52px;color:#94a3b8;font-weight:600;">Roll No</span><span>: ${s.roll_no||'-'}</span></div>
                <div style="display:flex;padding:1.5px 0;border-bottom:1px dotted #e0e0e0;"><span style="width:52px;color:#94a3b8;font-weight:600;">Father</span><span>: ${s.father_name||'-'}</span></div>
                <div style="display:flex;padding:1.5px 0;"><span style="width:52px;color:#94a3b8;font-weight:600;">Gender</span><span>: ${s.gender||'-'}</span></div>
              </div>
            </div>
            ${backBarcode}
            <div style="display:flex;justify-content:space-between;align-items:flex-end;">
              <div style="text-align:center;"><div style="height:1px;width:50px;background:#bbb;margin:0 auto 1px;"></div><div style="font-size:0.38rem;color:#888;">Student</div></div>
              <div style="text-align:center;"><div style="height:1px;width:50px;background:#bbb;margin:0 auto 1px;"></div><div style="font-size:0.38rem;color:#888;">Principal</div></div>
            </div>
          </div>
          <div style="background:#1565c0;padding:2px 8px;text-align:center;"><div style="font-size:0.35rem;color:rgba(255,255,255,0.7);">Property of ${schoolName||'SCHOOL'} | If found please return</div></div>
        </div>
      </div>`;
    }

    return generateIdCardHtml(student, 'classic', schoolName, logoPath, includeQr, includeBarcode);
  }

  function generateTeacherIdCardHtml(teacher, design, schoolName, logoPath, includeQr, principalSign) {
    const s = { name: teacher.name, father_name: '', student_id: teacher.id, class_name: 'Teacher', roll_no: '', phone: teacher.phone, dob: '', gender: '', photo: teacher.photo || '', class_name: `Subject: ${teacher.subject||'-'}` };
    return generateIdCardHtml(s, design, schoolName, logoPath, includeQr, false, principalSign);
  }

  function generateStaffIdCardHtml(staff, design, schoolName, logoPath, includeQr, principalSign) {
    const s = { name: staff.name, father_name: staff.designation, student_id: '', class_name: 'Staff', roll_no: '', phone: staff.phone, dob: '', gender: '', photo: '' };
    return generateIdCardHtml(s, design, schoolName, logoPath, includeQr, false, principalSign);
  }

  // Student ID Card: Generate
  document.getElementById('btn-idcard-stu-generate').addEventListener('click', async () => {
    const studentData = JSON.parse(document.getElementById('idcard-stu-student').dataset.studentData || '{}');
    const design = document.getElementById('idcard-stu-design').value;
    const includeQr = document.getElementById('idcard-stu-qr').value === '1';
    const includeBarcode = document.getElementById('idcard-stu-barcode').value === '1';

    let settings = {}, principalSign = null;
    try {
      const [settingsRaw, templatesRaw] = await Promise.all([
        apiCall('/settings'),
        apiCall('/exams/rollno-templates').catch(() => [])
      ]);
      settings = settingsRaw;
      if (templatesRaw.length > 0 && templatesRaw[0].template && templatesRaw[0].template.principal_sign) {
        principalSign = templatesRaw[0].template.principal_sign;
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }

    const html = generateIdCardHtml(studentData, design, settings.school_name, settings.logo_path, includeQr, includeBarcode, principalSign);
    document.getElementById('idcard-stu-printable').innerHTML = html;
    document.getElementById('idcard-stu-preview-container').style.display = 'block';
  });

  // Student ID Card: Print
  document.getElementById('btn-idcard-stu-print').addEventListener('click', () => {
    const content = document.getElementById('idcard-stu-printable').innerHTML;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Student ID Card</title><style>@media print{body{margin:0;}}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f1f5f9;}}</style></head><body>${content}</body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  });

  // Student ID Card: Download (using html2canvas-like approach via canvas)
  document.getElementById('btn-idcard-stu-download').addEventListener('click', () => {
    showToast('Tip: Right-click the card and "Save as image", or use Print > Save as PDF');
  });

  // Teacher ID Card: Generate
  document.getElementById('btn-idcard-teach-generate').addEventListener('click', async () => {
    const teacherData = JSON.parse(document.getElementById('idcard-teach-teacher').dataset.teacherData || '{}');
    const design = document.getElementById('idcard-teach-design').value;
    const includeQr = document.getElementById('idcard-teach-qr').value === '1';

    let settings = {}, principalSign = null;
    try {
      const [settingsRaw, templatesRaw] = await Promise.all([
        apiCall('/settings'),
        apiCall('/exams/rollno-templates').catch(() => [])
      ]);
      settings = settingsRaw;
      if (templatesRaw.length > 0 && templatesRaw[0].template && templatesRaw[0].template.principal_sign) {
        principalSign = templatesRaw[0].template.principal_sign;
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }

    const html = generateTeacherIdCardHtml(teacherData, design, settings.school_name, settings.logo_path, includeQr, principalSign);
    document.getElementById('idcard-teach-printable').innerHTML = html;
    document.getElementById('idcard-teach-preview-container').style.display = 'block';
  });

  // Teacher ID Card: Print
  document.getElementById('btn-idcard-teach-print').addEventListener('click', () => {
    const content = document.getElementById('idcard-teach-printable').innerHTML;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Teacher ID Card</title><style>@media print{body{margin:0;}}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f1f5f9;}}</style></head><body>${content}</body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  });

  // Staff ID Card: Generate
  document.getElementById('btn-idcard-staff-generate').addEventListener('click', async () => {
    const name = document.getElementById('idcard-staff-name').value.trim();
    const designation = document.getElementById('idcard-staff-desig').value.trim();
    const phone = document.getElementById('idcard-staff-phone').value.trim();
    const cnic = document.getElementById('idcard-staff-cnic').value.trim();
    const design = document.getElementById('idcard-staff-design').value;
    const includeQr = document.getElementById('idcard-staff-qr').value === '1';

    if (!name || !designation) { showToast('Please enter staff name and designation', true); return; }

    let settings = {}, principalSign = null;
    try {
      const [settingsRaw, templatesRaw] = await Promise.all([
        apiCall('/settings'),
        apiCall('/exams/rollno-templates').catch(() => [])
      ]);
      settings = settingsRaw;
      if (templatesRaw.length > 0 && templatesRaw[0].template && templatesRaw[0].template.principal_sign) {
        principalSign = templatesRaw[0].template.principal_sign;
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }

    const staff = { name, designation, phone, cnic };
    const html = generateStaffIdCardHtml(staff, design, settings.school_name, settings.logo_path, includeQr, principalSign);
    document.getElementById('idcard-staff-printable').innerHTML = html;
    document.getElementById('idcard-staff-preview-container').style.display = 'block';
  });

  // Staff ID Card: Print
  document.getElementById('btn-idcard-staff-print').addEventListener('click', () => {
    const content = document.getElementById('idcard-staff-printable').innerHTML;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Staff ID Card</title><style>@media print{body{margin:0;}}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f1f5f9;}}</style></head><body>${content}</body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  });

  // ==========================================
  // MODULE: CLASS-WISE BATCH ID CARD GENERATOR
  // ==========================================

  async function loadPMIdCardClasswise() {
    try {
      const classes = await apiCall('/students/classes');
      const classSelect = document.getElementById('idcard-cw-class');
      if (classSelect) {
        classSelect.innerHTML = '<option value="">-- Select Class --</option>';
        classes.forEach(c => {
          const name = typeof c === 'object' ? c.class_name : c;
          classSelect.innerHTML += `<option value="${name}">${name}</option>`;
        });
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  document.getElementById('idcard-cw-class').addEventListener('change', async function() {
    const className = this.value;
    document.getElementById('btn-idcard-cw-generate').disabled = true;
    document.getElementById('idcard-cw-info').style.display = 'none';
    document.getElementById('idcard-cw-preview-container').style.display = 'none';
    if (!className) return;
    try {
      const students = await apiCall(`/students?class_name=${encodeURIComponent(className)}`);
      document.getElementById('idcard-cw-count').textContent = students.length;
      document.getElementById('idcard-cw-classname').textContent = className;
      document.getElementById('idcard-cw-info').style.display = 'block';
      document.getElementById('btn-idcard-cw-generate').disabled = students.length === 0;
      document.getElementById('idcard-cw-class').dataset.studentsData = JSON.stringify(students);
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  document.getElementById('btn-idcard-cw-generate').addEventListener('click', async () => {
    const className = document.getElementById('idcard-cw-class').value;
    const design = document.getElementById('idcard-cw-design').value;
    const includeQr = document.getElementById('idcard-cw-qr').value === '1';
    const includeBarcode = document.getElementById('idcard-cw-barcode').value === '1';
    const colsPerRow = parseInt(document.getElementById('idcard-cw-layout').value) || 3;
    const students = JSON.parse(document.getElementById('idcard-cw-class').dataset.studentsData || '[]');
    if (!students.length) { showToast('No students found for this class', true); return; }

    let settings = {}, principalSign = null;
    try {
      const [settingsRaw, templatesRaw] = await Promise.all([
        apiCall('/settings'),
        apiCall('/exams/rollno-templates').catch(() => [])
      ]);
      settings = settingsRaw;
      if (templatesRaw.length > 0 && templatesRaw[0].template && templatesRaw[0].template.principal_sign) {
        principalSign = templatesRaw[0].template.principal_sign;
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }

    let cardsHtml = '';
    for (const s of students) {
      const fullStudent = await apiCall(`/students/${s.id}`).then(d => d.student).catch(() => s);
      cardsHtml += generateIdCardHtml(fullStudent, design, settings.school_name, settings.logo_path, includeQr, includeBarcode, principalSign);
    }

    const container = document.getElementById('idcard-cw-printable');
    container.style.gridTemplateColumns = `repeat(${colsPerRow}, 1fr)`;
    container.style.display = 'grid';
    container.innerHTML = cardsHtml;
    document.getElementById('idcard-cw-preview-container').style.display = 'block';
  });

  document.getElementById('btn-idcard-cw-print').addEventListener('click', () => {
    const content = document.getElementById('idcard-cw-printable').innerHTML;
    const colsPerRow = document.getElementById('idcard-cw-layout').value || 3;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Class ID Cards</title><style>
      @media print{body{margin:0;}}
      body{background:#f1f5f9;padding:20px;}
      .cards-grid{display:grid;grid-template-columns:repeat(${colsPerRow},1fr);gap:12px;justify-items:center;}
    </style></head><body><div class="cards-grid">${content}</div></body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 800);
  });

  document.getElementById('btn-idcard-cw-download').addEventListener('click', () => {
    showToast('Tip: Use Print > Save as PDF to download all cards');
  });

  // ==========================================
  // MODULE: CERTIFICATE GENERATOR
  // ==========================================
  let certSelectedStudent = null;

  // Set current year in session field
  const certCharSession = document.getElementById('cert-char-session');
  if (certCharSession) {
    const y = new Date().getFullYear();
    certCharSession.value = `${y-1}-${y}`;
  }

  // Search students
  document.getElementById('cert-student-search-btn').addEventListener('click', async () => {
    const q = document.getElementById('cert-student-search').value.trim();
    if (!q) return;
    try {
      const students = await apiCall(`/students/all?q=${encodeURIComponent(q)}`);
      const resultsDiv = document.getElementById('cert-student-results');
      if (!students.length) { resultsDiv.innerHTML = '<div style="padding:8px;color:var(--text-muted);">No students found</div>'; resultsDiv.style.display='block'; return; }
      resultsDiv.innerHTML = students.slice(0,10).map(st => `
        <div style="padding:8px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.05);display:flex;align-items:center;gap:8px;" class="cert-student-pick" data-id="${st.id}" data-name="${st.name}" data-class="${st.class_name}" data-photo="${st.photo||''}" data-father="${st.father_name||''}" data-roll="${st.roll_no||''}" data-stid="${st.student_id||''}" data-dob="${st.dob||''}" data-gender="${st.gender||''}" data-section="${st.section_name||''}">
          <img src="${st.photo ? (st.photo.startsWith('data:') ? st.photo : '/' + st.photo) : 'school_assets/school_logo.png'}" style="width:32px;height:32px;border-radius:6px;object-fit:cover;">
          <div><div style="font-weight:600;font-size:0.85rem;">${st.name}</div><div style="font-size:0.7rem;color:var(--text-muted);">${st.class_name} | Roll: ${st.roll_no||'-'} | ID: ${st.student_id||'-'}</div></div>
        </div>
      `).join('');
      resultsDiv.style.display='block';
      resultsDiv.querySelectorAll('.cert-student-pick').forEach(el => {
        el.addEventListener('click', () => {
          certSelectedStudent = {
            id: el.dataset.id, name: el.dataset.name, class_name: el.dataset.class,
            photo: el.dataset.photo, father_name: el.dataset.father, roll_no: el.dataset.roll,
            student_id: el.dataset.stid, dob: el.dataset.dob, gender: el.dataset.gender,
            section_name: el.dataset.section
          };
          document.getElementById('cert-student-name').textContent = certSelectedStudent.name;
          document.getElementById('cert-student-class').textContent = `${certSelectedStudent.class_name} | Roll: ${certSelectedStudent.roll_no} | Section: ${certSelectedStudent.section_name}`;
          document.getElementById('cert-student-id').textContent = `ID: ${certSelectedStudent.student_id}`;
          document.getElementById('cert-student-photo').src = certSelectedStudent.photo ? (certSelectedStudent.photo.startsWith('data:') ? certSelectedStudent.photo : '/' + certSelectedStudent.photo) : 'school_assets/school_logo.png';
          document.getElementById('cert-student-info').style.display='block';
          resultsDiv.style.display='none';
        });
      });
    } catch (e) { showToast('Error searching students', true); }
  });

  // Enter key search
  document.getElementById('cert-student-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cert-student-search-btn').click(); }
  });

  // Certificate HTML generators
  function generateLeaveCertificateHtml(s, startDate, endDate, reason, schoolName, logoSrc, principalSign) {
    const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    return `<div style="width:8.5in;height:11in;background:#fff;border:3px double #1a237e;padding:0.5in;font-family:'Georgia',serif;position:relative;">
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${logoSrc}" style="height:70px;border-radius:8px;" onerror="this.style.display='none'">
        <div style="font-size:1.6rem;font-weight:900;color:#1a237e;margin-top:8px;letter-spacing:2px;text-transform:uppercase;">${schoolName||'SCHOOL NAME'}</div>
        <div style="font-size:0.85rem;color:#555;letter-spacing:1px;">School Address | Phone | Email</div>
        <div style="width:100%;height:3px;background:linear-gradient(90deg,#1a237e,#ffc107,#1a237e);margin-top:8px;"></div>
      </div>
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:1.8rem;font-weight:700;color:#1a237e;border-bottom:3px solid #ffc107;display:inline-block;padding-bottom:4px;">LEAVE CERTIFICATE</div>
      </div>
      <div style="font-size:1rem;color:#333;line-height:2;">
        <div style="margin-bottom:8px;">Date: <strong>${today}</strong></div>
        <p style="text-indent:40px;">
          This is to certify that <strong style="color:#1a237e;font-size:1.1rem;">${s.name}</strong>,
          ${s.father_name ? `son/daughter of <strong>${s.father_name}</strong>,` : ''}
          studying in <strong>${s.class_name}</strong>${s.section_name ? `, Section <strong>${s.section_name}</strong>` : ''}
          (Roll No: <strong>${s.roll_no||'-'}</strong>, Student ID: <strong>${s.student_id||'-'}</strong>),
          has been granted leave from <strong>${startDate}</strong> to <strong>${endDate}</strong>
          due to <strong>${reason||'personal reasons'}</strong>.
        </p>
        <p style="text-indent:40px;">The leave period totals <strong>${Math.ceil((new Date(endDate) - new Date(startDate)) / 86400000) + 1} day(s)</strong>.</p>
      </div>
      <div style="margin-top:60px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div style="text-align:center;">
          <div style="height:1px;width:120px;background:#333;margin-bottom:4px;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Student's Signature</div>
        </div>
        <div style="text-align:center;">
          ${principalSign ? `<img src="${principalSign}" style="height:40px;max-width:120px;object-fit:contain;" onerror="this.style.display='none'">` : '<div style="height:40px;"></div>'}
          <div style="height:1px;width:120px;background:#333;margin:4px auto;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Principal's Signature</div>
          <div style="font-size:0.75rem;color:#888;">(School Stamp)</div>
        </div>
      </div>
    </div>`;
  }

  function generateCharacterCertificateHtml(s, session, conduct, schoolName, logoSrc, principalSign) {
    const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    return `<div style="width:8.5in;height:11in;background:#fff;border:3px double #1b5e20;padding:0.5in;font-family:'Georgia',serif;position:relative;">
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${logoSrc}" style="height:70px;border-radius:8px;" onerror="this.style.display='none'">
        <div style="font-size:1.6rem;font-weight:900;color:#1b5e20;margin-top:8px;letter-spacing:2px;text-transform:uppercase;">${schoolName||'SCHOOL NAME'}</div>
        <div style="font-size:0.85rem;color:#555;letter-spacing:1px;">School Address | Phone | Email</div>
        <div style="width:100%;height:3px;background:linear-gradient(90deg,#1b5e20,#ffc107,#1b5e20);margin-top:8px;"></div>
      </div>
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:1.8rem;font-weight:700;color:#1b5e20;border-bottom:3px solid #ffc107;display:inline-block;padding-bottom:4px;">CHARACTER CERTIFICATE</div>
      </div>
      <div style="font-size:1rem;color:#333;line-height:2;">
        <div style="margin-bottom:8px;">Date: <strong>${today}</strong></div>
        <p style="text-indent:40px;">
          This is to certify that <strong style="color:#1b5e20;font-size:1.1rem;">${s.name}</strong>,
          ${s.father_name ? `son/daughter of <strong>${s.father_name}</strong>,` : ''}
          S/O <strong>${s.father_name||'-'}</strong>,
          studying in <strong>${s.class_name}</strong>${s.section_name ? `, Section <strong>${s.section_name}</strong>` : ''}
          (Roll No: <strong>${s.roll_no||'-'}</strong>, Student ID: <strong>${s.student_id||'-'}</strong>),
          ${s.dob ? `born on <strong>${s.dob}</strong>,` : ''}
          has attended this school during the academic session <strong>${session}</strong>.
        </p>
        <p style="text-indent:40px;">${conduct}</p>
        <p style="text-indent:40px;">We wish him/her all the best for future endeavors.</p>
      </div>
      <div style="margin-top:60px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div style="text-align:center;">
          <div style="height:1px;width:120px;background:#333;margin-bottom:4px;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Student's Signature</div>
        </div>
        <div style="text-align:center;">
          ${principalSign ? `<img src="${principalSign}" style="height:40px;max-width:120px;object-fit:contain;" onerror="this.style.display='none'">` : '<div style="height:40px;"></div>'}
          <div style="height:1px;width:120px;background:#333;margin:4px auto;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Principal's Signature</div>
          <div style="font-size:0.75rem;color:#888;">(School Stamp)</div>
        </div>
      </div>
    </div>`;
  }

  function generateSportsCertificateHtml(s, event, achievement, eventDate, details, schoolName, logoSrc, principalSign) {
    const today = new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
    return `<div style="width:8.5in;height:11in;background:#fff;border:3px double #e65100;padding:0.5in;font-family:'Georgia',serif;position:relative;">
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${logoSrc}" style="height:70px;border-radius:8px;" onerror="this.style.display='none'">
        <div style="font-size:1.6rem;font-weight:900;color:#e65100;margin-top:8px;letter-spacing:2px;text-transform:uppercase;">${schoolName||'SCHOOL NAME'}</div>
        <div style="font-size:0.85rem;color:#555;letter-spacing:1px;">School Address | Phone | Email</div>
        <div style="width:100%;height:3px;background:linear-gradient(90deg,#e65100,#ffc107,#e65100);margin-top:8px;"></div>
      </div>
      <div style="text-align:center;margin-bottom:20px;">
        <div style="font-size:1.8rem;font-weight:700;color:#e65100;border-bottom:3px solid #ffc107;display:inline-block;padding-bottom:4px;">🏆 SPORTS ACHIEVEMENT CERTIFICATE</div>
      </div>
      <div style="font-size:1rem;color:#333;line-height:2;">
        <div style="margin-bottom:8px;">Date: <strong>${today}</strong></div>
        <p style="text-indent:40px;">
          This certificate is proudly presented to
          <strong style="color:#e65100;font-size:1.1rem;">${s.name}</strong>,
          ${s.father_name ? `son/daughter of <strong>${s.father_name}</strong>,` : ''}
          studying in <strong>${s.class_name}</strong>${s.section_name ? `, Section <strong>${s.section_name}</strong>` : ''}
          (Roll No: <strong>${s.roll_no||'-'}</strong>),
        </p>
        <p style="text-indent:40px;">
          for achieving <strong style="color:#e65100;font-size:1.1rem;">${achievement}</strong>
          in <strong>${event}</strong>
          ${eventDate ? `held on <strong>${eventDate}</strong>` : ''}.
        </p>
        ${details ? `<p style="text-indent:40px;">${details}</p>` : ''}
        <p style="text-indent:40px;">We congratulate him/her on this remarkable achievement and wish continued success in all future endeavors.</p>
      </div>
      <div style="margin-top:60px;display:flex;justify-content:space-between;align-items:flex-end;">
        <div style="text-align:center;">
          <div style="height:1px;width:120px;background:#333;margin-bottom:4px;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Student's Signature</div>
        </div>
        <div style="text-align:center;">
          <div style="height:1px;width:120px;background:#333;margin-bottom:4px;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Sports Teacher</div>
        </div>
        <div style="text-align:center;">
          ${principalSign ? `<img src="${principalSign}" style="height:40px;max-width:120px;object-fit:contain;" onerror="this.style.display='none'">` : '<div style="height:40px;"></div>'}
          <div style="height:1px;width:120px;background:#333;margin:4px auto;"></div>
          <div style="font-size:0.85rem;font-weight:600;">Principal's Signature</div>
          <div style="font-size:0.75rem;color:#888;">(School Stamp)</div>
        </div>
      </div>
    </div>`;
  }

  async function fetchCertSettings() {
    let settings = {}, principalSign = null;
    try {
      const [settingsRaw, templatesRaw] = await Promise.all([
        apiCall('/settings'),
        apiCall('/exams/rollno-templates').catch(() => [])
      ]);
      settings = settingsRaw;
      if (templatesRaw.length > 0 && templatesRaw[0].template && templatesRaw[0].template.principal_sign) {
        principalSign = templatesRaw[0].template.principal_sign;
      }
    } catch (e) { console.error('[APP_ERROR]', e.message); }
    return { settings, principalSign };
  }

  function certValidateStudent() {
    if (!certSelectedStudent) { showToast('Please select a student first', true); return false; }
    return true;
  }

  // Generate Leave Certificate
  document.getElementById('cert-leave-generate').addEventListener('click', async () => {
    if (!certValidateStudent()) return;
    const startDate = document.getElementById('cert-leave-start').value;
    const endDate = document.getElementById('cert-leave-end').value;
    const reason = document.getElementById('cert-leave-reason').value;
    if (!startDate || !endDate) { showToast('Please select start and end dates', true); return; }
    const { settings, principalSign } = await fetchCertSettings();
    const html = generateLeaveCertificateHtml(certSelectedStudent, startDate, endDate, reason, settings.school_name, imgSrc(settings.logo_path, 'school_assets/school_logo.png'), principalSign);
    document.getElementById('cert-printable').innerHTML = html;
    document.getElementById('cert-preview-container').style.display='block';
  });

  // Generate Character Certificate
  document.getElementById('cert-char-generate').addEventListener('click', async () => {
    if (!certValidateStudent()) return;
    const session = document.getElementById('cert-char-session').value;
    const conduct = document.getElementById('cert-char-conduct').value;
    if (!session) { showToast('Please enter the academic session', true); return; }
    const { settings, principalSign } = await fetchCertSettings();
    const html = generateCharacterCertificateHtml(certSelectedStudent, session, conduct, settings.school_name, imgSrc(settings.logo_path, 'school_assets/school_logo.png'), principalSign);
    document.getElementById('cert-printable').innerHTML = html;
    document.getElementById('cert-preview-container').style.display='block';
  });

  // Generate Sports Certificate
  document.getElementById('cert-sports-generate').addEventListener('click', async () => {
    if (!certValidateStudent()) return;
    const event = document.getElementById('cert-sports-event').value;
    const achievement = document.getElementById('cert-sports-achievement').value;
    const eventDate = document.getElementById('cert-sports-date').value;
    const details = document.getElementById('cert-sports-details').value;
    if (!event || !achievement) { showToast('Please enter event name and achievement', true); return; }
    const { settings, principalSign } = await fetchCertSettings();
    const html = generateSportsCertificateHtml(certSelectedStudent, event, achievement, eventDate, details, settings.school_name, imgSrc(settings.logo_path, 'school_assets/school_logo.png'), principalSign);
    document.getElementById('cert-printable').innerHTML = html;
    document.getElementById('cert-preview-container').style.display='block';
  });

  // Certificate Print
  document.getElementById('cert-print').addEventListener('click', () => {
    const content = document.getElementById('cert-printable').innerHTML;
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Certificate</title><style>@media print{body{margin:0;}}body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#f1f5f9;}</style></head><body>${content}</body></html>`);
    printWindow.document.close();
    setTimeout(() => { printWindow.print(); }, 500);
  });

  // Certificate Download
  document.getElementById('cert-download').addEventListener('click', () => {
    showToast('Tip: Right-click the certificate and "Save as image", or use Print > Save as PDF');
  });

  // ==========================================
  // MODULE: STUDENTS
  // ==========================================
  let cachedClasses = [];

  async function loadClassesList() {
    try {
      const classes = await getCachedClasses(apiCall);
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
      const slipClassSelect = document.getElementById('slip-class');
      const datesheetClassSelect = document.getElementById('datesheet-class-select');
      const rollnoClassSelect = document.getElementById('rollno-class-select');
      const rollnoGenClass = document.getElementById('rollno-gen-class');

      const selects = [
        filterClass, attClassSelect, attHistoryClass, ledgerFilterClass,
        marksSelectClass, calcClassSelect,
        historyFilterClass, studentFeeClass, reminderFilterClass,
        slipClassSelect, datesheetClassSelect, rollnoClassSelect, rollnoGenClass
      ];

      const optsHtml = classes.map(cls => `<option value="${cls}">${cls}</option>`).join('');

      selects.forEach(sel => {
        if (!sel) return;
        const currentVal = sel.value;
        const isAllClasses = ['student-filter-class', 'history-filter-class', 'student-fee-class', 'datesheet-class-select', 'rollno-class-select', 'rollno-gen-class'].includes(sel.id);
        const isSelectPlaceholder = ['reminder-filter-class', 'slip-class'].includes(sel.id);
        
        if (isAllClasses) {
          sel.innerHTML = '<option value="">All Classes</option>' + optsHtml;
        } else if (isSelectPlaceholder) {
          sel.innerHTML = '<option value="">-- Select Class --</option>' + optsHtml;
        } else {
          sel.innerHTML = optsHtml;
        }
        if (currentVal) sel.value = currentVal;
      });

    } catch (e) { console.error('[CLASSES_LIST]', e.message); }
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

      const rows = students.map(s => {
        const hasSibling = s.family_head_id ? `<span class="sib-badge">Sibling</span>` : (s.family_head_id === null ? '' : '');
        const roleText = s.family_head_id ? `Linked to Head` : 'Family Head';
        
        let waiverText = 'Standard';
        if (s.is_free) waiverText = '<span style="color: var(--accent);">Free Waiver</span>';
        else if (s.discount_amount > 0) waiverText = `-${s.discount_amount} PKR`;
        else if (s.discount_percent > 0) waiverText = `-${s.discount_percent}%`;

        return `
          <tr>
            <td>${s.student_id}</td>
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td>
              <div style="display:flex; align-items:center; gap: 10px;">
                <img src="${imgSrc(s.photo, 'school_assets/school_logo.png')}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;" onerror="this.src='/school_assets/school_logo.png'">
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
      tbody.innerHTML = rows.join('');

      // Bind events
      attachStudentTableEvents();

    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // Filter Listeners — Search button triggers the query
  document.getElementById('btn-student-search').addEventListener('click', loadStudentsList);
  document.getElementById('student-filter-class').addEventListener('change', async function() {
    const className = this.value;
    const sectionSelect = document.getElementById('student-filter-section');
    sectionSelect.innerHTML = '<option value="">All Sections</option><option value="No Section">No Section</option>';
    if (className) {
      try {
        const sections = await apiCall(`/students/sections/${encodeURIComponent(className)}`);
        sections.forEach(s => {
          if (s.section_name) sectionSelect.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`;
        });
      } catch (e) { console.error('[APP_ERROR]', e.message); }
    }
    loadStudentsList();
  });
  document.getElementById('student-filter-section').addEventListener('change', loadStudentsList);
  document.getElementById('student-search').addEventListener('keydown', function(e) { if (e.key === 'Enter') loadStudentsList(); });

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

  // Compress image to target KB using Canvas with quality scaling
  function compressImage(file, maxKB) {
    return new Promise((resolve, reject) => {
      maxKB = maxKB || 100;
      const reader = new FileReader();
      reader.onload = function(e) {
        const img = new Image();
        img.onload = function() {
          let width = img.width;
          let height = img.height;
          // Scale down if larger than 1024px on any side for good quality
          const maxDim = 1024;
          if (width > maxDim || height > maxDim) {
            if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
            else { width = Math.round(width * maxDim / height); height = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          // Start with high quality, reduce incrementally
          let quality = 0.85;
          const tryCompress = () => {
            canvas.toBlob(function(blob) {
              if (!blob) { reject(new Error('Canvas compression failed')); return; }
              if (blob.size > maxKB * 1024 && quality > 0.1) {
                quality -= 0.05;
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
    formData.append('blood_group', document.getElementById('stud-blood').value || '');
    formData.append('address', document.getElementById('stud-address').value || '');
    formData.append('previous_school', document.getElementById('stud-prev-school').value || '');
    formData.append('previous_school_contact', document.getElementById('stud-prev-school-contact').value || '');

    const fileInput = document.getElementById('stud-photo-file');
    if (fileInput.files[0]) {
      try {
        const compressed = await compressImage(fileInput.files[0], 100);
        formData.append('photo', compressed, 'photo.jpg');
      } catch (e) {
        // Fallback: try with 200KB limit
        try {
          const compressed = await compressImage(fileInput.files[0], 200);
          formData.append('photo', compressed, 'photo.jpg');
        } catch (e2) {
          formData.append('photo', fileInput.files[0]);
        }
      }
    }

    try {
      const endpoint = isEdit ? `/students/${editId}` : '/students';
      const method = isEdit ? 'PUT' : 'POST';

      const res = await apiCall(endpoint, method, formData, true);
      showToast(res.message);
      invalidateClassCache();
      modalStudent.classList.remove('open');
      loadStudentsList();
      loadClassesList();
    } catch (err) { console.error('[APP_ERROR]', err.message); }
  });

  // Table events linking — use event delegation to avoid memory leaks
  let _studentTableDelegationBound = false;
  function attachStudentTableEvents() {
    if (_studentTableDelegationBound) return;
    _studentTableDelegationBound = true;

    const modalQr = document.getElementById('modal-print-qr');
    const qrPlaceholder = document.getElementById('qr-code-placeholder');
    const modalSibling = document.getElementById('modal-sibling');
    const sibHeadSelect = document.getElementById('sib-head-select');

    // Event delegation on the student table body
    document.querySelector('#table-students tbody').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;

      if (btn.classList.contains('btn-edit-student')) {
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
          document.getElementById('stud-blood').value = s.blood_group || '';
          document.getElementById('stud-address').value = s.address || '';
          document.getElementById('stud-prev-school').value = s.previous_school || '';
          document.getElementById('stud-prev-school-contact').value = s.previous_school_contact || '';

          modalStudent.classList.add('open');
        } catch (e) { console.error('[APP_ERROR]', e.message); }
      }

      if (btn.classList.contains('btn-archive-student')) {
        const id = btn.getAttribute('data-id');
        if (confirm('Are you sure you want to mark this student as Left (Inactive)?')) {
          try {
            const res = await apiCall(`/students/${id}/archive`, 'POST');
            showToast(res.message);
            loadStudentsList();
          } catch (e) { console.error('[APP_ERROR]', e.message); }
        }
      }

      if (btn.classList.contains('btn-qr-student')) {
        const name = btn.getAttribute('data-name');
        const roll = btn.getAttribute('data-roll');
        const className = btn.getAttribute('data-class');
        const code = btn.getAttribute('data-code');

        document.getElementById('qr-card-school').innerText = currentUser.schoolName;
        document.getElementById('qr-card-name').innerText = name;
        document.getElementById('qr-card-roll').innerText = `Roll No: ${roll || 'N/A'} | Class: ${className}`;
        document.getElementById('qr-card-id').innerText = `Student ID: ${code}`;

        qrPlaceholder.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(code)}" alt="Student Code QR" style="width:130px; height:130px;">`;
        
        modalQr.classList.add('open');
      }

      if (btn.classList.contains('btn-sib-student')) {
        const id = btn.getAttribute('data-id');
        const name = btn.getAttribute('data-name');
        const currentHead = btn.getAttribute('data-head');

        document.getElementById('sib-student-id').value = id;
        document.getElementById('sib-target-student').innerText = name;
        document.getElementById('sib-target-status').innerText = currentHead ? `Sibling (linked to ID: ${currentHead})` : 'Individual Account (unlinked)';
        
        try {
          const candidates = await apiCall(`/students/sibling-candidates/all?excludeId=${id}`);
          sibHeadSelect.innerHTML = '<option value="">-- Choose Head Student --</option>';
          candidates.forEach(c => {
            sibHeadSelect.innerHTML += `<option value="${c.id}">${c.name} (Roll: ${c.roll_no}, Class: ${c.class_name}, Father: ${c.father_name})</option>`;
          });

          if (currentHead) sibHeadSelect.value = currentHead;
          modalSibling.classList.add('open');
        } catch (e) { console.error('[APP_ERROR]', e.message); }
      }
    });

    // Global modal buttons — bound ONCE
    document.getElementById('btn-close-qr-modal').addEventListener('click', () => {
      modalQr.classList.remove('open');
    });

    document.getElementById('btn-print-qr-execute').addEventListener('click', () => {
      const printContents = document.getElementById('print-card-content').innerHTML;
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`
        <html><head><title>Print Card</title></head>
        <body style="display:flex; align-items:center; justify-content:center; height:100vh; background:white; margin:0;">
          <div style="width:300px; padding:20px; border:2px solid black; border-radius:10px; text-align:center;">
            ${printContents}
          </div>
        </body></html>
      `);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      printWindow.close();
    });

    document.getElementById('btn-close-sib-modal').addEventListener('click', () => {
      modalSibling.classList.remove('open');
    });

    document.getElementById('form-link-sibling').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('sib-student-id').value;
      const familyHeadId = sibHeadSelect.value;

      try {
        const data = await apiCall(`/students/${id}`);
        const s = data.student;
        s.family_head_id = familyHeadId;

        await apiCall(`/students/${id}`, 'PUT', s);
        showToast('Sibling association linked successfully!');
        modalSibling.classList.remove('open');
        loadStudentsList();
      } catch (err) { console.error('[APP_ERROR]', err.message); }
    });

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
      } catch (err) { console.error('[APP_ERROR]', err.message); }
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  document.getElementById('sp-class-select').addEventListener('change', async function() {
    const className = this.value;
    const sectionSelect = document.getElementById('sp-section-select');
    sectionSelect.innerHTML = '<option value="">-- All Sections --</option>';
    document.getElementById('sp-profile-container').style.display = 'none';
    if (className) {
      try {
        const sections = await apiCall(`/students/sections/${encodeURIComponent(className)}`);
        sections.forEach(s => { sectionSelect.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`; });
      } catch (e) { console.error('[APP_ERROR]', e.message); }
    }
    loadStudentProfileList();
  });

  document.getElementById('sp-section-select').addEventListener('change', () => {
    document.getElementById('sp-profile-container').style.display = 'none';
    loadStudentProfileList();
  });

  document.getElementById('sp-search-input').addEventListener('input', debounce(() => {
    document.getElementById('sp-profile-container').style.display = 'none';
    loadStudentProfileList();
  }, 300));

  document.getElementById('sp-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('sp-profile-container').style.display = 'none';
      loadStudentProfileList();
    }
  });

  document.getElementById('sp-search-btn').addEventListener('click', () => {
    document.getElementById('sp-profile-container').style.display = 'none';
    loadStudentProfileList();
  });

  async function loadStudentProfileList() {
    const className = document.getElementById('sp-class-select').value;
    const sectionName = document.getElementById('sp-section-select').value;
    const search = document.getElementById('sp-search-input').value.trim();
    const studentSelect = document.getElementById('sp-student-select');

    if (!className && !sectionName && !search) {
      studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
      return;
    }

    studentSelect.innerHTML = '<option value="">Loading...</option>';

    try {
      let url = '/students/all?';
      if (className) url += `class_name=${encodeURIComponent(className)}&`;
      if (sectionName) url += `section_name=${encodeURIComponent(sectionName)}&`;
      if (search) url += `search=${encodeURIComponent(search)}&`;
      const students = await apiCall(url);
      studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
      if (students.length === 0) {
        studentSelect.innerHTML = '<option value="">-- No students found --</option>';
      } else {
        students.forEach(s => {
          const statusLabel = s.status === 'Left' ? ' [LEFT]' : '';
          studentSelect.innerHTML += `<option value="${s.id}">${s.roll_no || '-'} - ${s.name}${statusLabel}</option>`;
        });
      }
    } catch (e) {
      studentSelect.innerHTML = '<option value="">-- Error loading --</option>';
      console.error('loadStudentProfileList error:', e);
    }
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

    document.getElementById('sp-student-name').innerText = 'Loading...';

    try {
      const data = await apiCall(`/students/${studentId}/profile`);
      const s = data.student;
      const stats = data.stats;

      // Header
      const avatarPhoto = document.getElementById('sp-avatar-photo');
      const avatarText = document.getElementById('sp-avatar-text');
      if (s.photo) {
        avatarPhoto.src = imgSrc(s.photo);
        avatarPhoto.style.display = 'block';
        avatarText.style.display = 'none';
      } else {
        avatarPhoto.style.display = 'none';
        avatarText.style.display = 'block';
        avatarText.innerText = (s.name || 'S')[0].toUpperCase();
      }
      document.getElementById('sp-student-name').innerText = s.name || 'Unknown';
      document.getElementById('sp-student-id').innerText = `ID: ${s.student_id || '-'}`;
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
      document.getElementById('sp-info-blood').innerText = s.blood_group || '-';
      document.getElementById('sp-info-religion').innerText = s.religion || '-';
      document.getElementById('sp-info-national-id').innerText = s.national_id || '-';

      // Overview - Stats
      document.getElementById('sp-total-marks').innerText = stats.totalMarksObtained;
      document.getElementById('sp-avg-marks').innerText = `${stats.avgPercentage}%`;
      document.getElementById('sp-pending-dues').innerText = stats.totalDue.toLocaleString();
      document.getElementById('sp-total-paid').innerText = stats.totalPaid.toLocaleString();

      // Parents
      const parentsContainer = document.getElementById('sp-parents-container');
      if (data.parents && data.parents.length > 0) {
        parentsContainer.innerHTML = data.parents.map(p => `
          <div class="sp-parent-card">
            <div class="sp-parent-name">${esc(p.name || '-')}</div>
            <div class="sp-parent-detail">Relation: ${esc(p.relation || '-')}</div>
            <div class="sp-parent-detail">Phone: ${esc(p.phone || '-')}</div>
            ${p.cnic ? `<div class="sp-parent-detail">CNIC: ${esc(p.cnic)}</div>` : ''}
            ${p.address ? `<div class="sp-parent-detail">Address: ${esc(p.address)}</div>` : ''}
          </div>
        `).join('');
      } else {
        parentsContainer.innerHTML = '<div class="sp-no-records"><div class="sp-no-records-icon">👨‍👩‍👧</div><div>No parent information available</div></div>';
      }

      // Admission
      document.getElementById('sp-adm-no').innerText = s.admission_no || '-';
      document.getElementById('sp-adm-date').innerText = s.admission_date || '-';
      document.getElementById('sp-adm-class').innerText = s.admission_class || '-';
      document.getElementById('sp-adm-current').innerText = `${s.class_name || '-'}${s.section_name ? ' - ' + s.section_name : ''}`;
      document.getElementById('sp-adm-slc').innerText = s.slc_no || '-';
      document.getElementById('sp-prev-school').innerText = s.previous_school || '-';
      document.getElementById('sp-prev-school-contact').innerText = s.previous_school_contact || '-';

      // Fee Ledger
      const feeLedgerBody = document.getElementById('sp-fee-ledger-body');
      if (data.feeLedger.length === 0) {
        feeLedgerBody.innerHTML = '<tr><td colspan="6" class="sp-no-records-row">No fee records found.</td></tr>';
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
        paymentsBody.innerHTML = '<tr><td colspan="5" class="sp-no-records-row">No payments found.</td></tr>';
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
        marksBody.innerHTML = '<tr><td colspan="7" class="sp-no-records-row">No marks found.</td></tr>';
      } else {
        marksBody.innerHTML = data.marks.map(m => {
          const maxM = m.max_marks || 100;
          const pct = maxM > 0 ? ((m.marks / maxM) * 100).toFixed(1) : 0;
          return `<tr>
            <td>${m.exam_name || '-'}</td>
            <td>${m.year || '-'}</td>
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
        resultsBody.innerHTML = '<tr><td colspan="8" class="sp-no-records-row">No results found.</td></tr>';
      } else {
        resultsBody.innerHTML = data.results.map(r => `<tr>
          <td>${r.exam_name || '-'}</td>
          <td>${r.year || '-'}</td>
          <td>${r.term || '-'}</td>
          <td>${r.total || '-'}</td>
          <td><strong>${r.obtained || '-'}</strong></td>
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
        attBody.innerHTML = '<tr><td colspan="3" class="sp-no-records-row">No attendance records found.</td></tr>';
      } else {
        attBody.innerHTML = data.attendance.map(a => {
          const isPresent = a.status === 'present' || a.status === 'Present';
          return `<tr>
            <td>${a.date || '-'}</td>
            <td><span class="badge ${isPresent ? 'badge-green' : 'badge-red'}">${a.status || '-'}</span></td>
            <td>${a.time || '-'}</td>
          </tr>`;
        }).join('');
      }

      // Homework
      const homeworkBody = document.getElementById('sp-homework-body');
      if (data.homework && data.homework.length > 0) {
        homeworkBody.innerHTML = data.homework.map(h => {
          const priorityClass = h.priority === 'high' ? 'badge-red' : h.priority === 'medium' ? 'badge-yellow' : 'badge-green';
          return `<tr>
            <td>${esc(h.title || '-')}</td>
            <td>${esc(h.subject || '-')}</td>
            <td><span class="badge badge-blue">${esc(h.type || 'homework')}</span></td>
            <td>${esc(h.teacher_name || '-')}</td>
            <td>${h.due_date || '-'}</td>
            <td><span class="badge ${priorityClass}">${esc(h.priority || 'medium')}</span></td>
            <td>${h.created_at || '-'}</td>
          </tr>`;
        }).join('');
      } else {
        homeworkBody.innerHTML = '<tr><td colspan="7" class="sp-no-records-row">No homework records found.</td></tr>';
      }

      // Certificates
      const certContainer = document.getElementById('sp-certificates-container');
      if (data.certificates && data.certificates.length > 0) {
        certContainer.innerHTML = data.certificates.map(c => `
          <div class="sp-cert-card">
            <div class="sp-cert-name">${esc(c.certificate_name || '-')}</div>
            <div class="sp-cert-detail">Type: ${esc(c.certificate_type || 'General')}</div>
            <div class="sp-cert-detail">Issue Date: ${c.issue_date || '-'}</div>
            ${c.description ? `<div class="sp-cert-detail">${esc(c.description)}</div>` : ''}
          </div>
        `).join('');
      } else {
        certContainer.innerHTML = '<div class="sp-no-records"><div class="sp-no-records-icon">📜</div><div>No certificates available</div></div>';
      }

      // Documents
      const docContainer = document.getElementById('sp-documents-container');
      if (data.documents && data.documents.length > 0) {
        docContainer.innerHTML = data.documents.map(d => `
          <div class="sp-doc-card">
            <div class="sp-doc-name">${esc(d.document_name || '-')}</div>
            <div class="sp-doc-detail">Type: ${esc(d.document_type || 'Other')}</div>
            <div class="sp-doc-detail">Uploaded: ${d.upload_date || d.created_at || '-'}</div>
            ${d.description ? `<div class="sp-doc-detail">${esc(d.description)}</div>` : ''}
          </div>
        `).join('');
      } else {
        docContainer.innerHTML = '<div class="sp-no-records"><div class="sp-no-records-icon">📁</div><div>No documents available</div></div>';
      }

      // Promotion History
      const promoContainer = document.getElementById('sp-promotion-container');
      if (data.promotionHistory && data.promotionHistory.length > 0) {
        promoContainer.innerHTML = data.promotionHistory.map(p => `
          <div class="sp-history-item">
            <div class="sp-history-title">${esc(p.from_class || '-')} → ${esc(p.to_class || '-')}</div>
            <div class="sp-history-detail">Year: ${p.exam_year || '-'} | Date: ${p.promotion_date || '-'}</div>
            <div class="sp-history-detail">Percentage: ${p.final_percentage ? p.final_percentage + '%' : '-'} | Grade: ${esc(p.final_grade || '-')}</div>
            ${p.remarks ? `<div class="sp-history-detail">Remarks: ${esc(p.remarks)}</div>` : ''}
          </div>
        `).join('');
      } else {
        promoContainer.innerHTML = '<div class="sp-no-records"><div class="sp-no-records-icon">📈</div><div>No promotion records available</div></div>';
      }

      // Transfer History
      const transferContainer = document.getElementById('sp-transfer-container');
      if (data.transferHistory && data.transferHistory.length > 0) {
        transferContainer.innerHTML = data.transferHistory.map(t => `
          <div class="sp-history-item">
            <div class="sp-history-title">${esc(t.from_class || '-')} → ${esc(t.to_class || '-')}</div>
            <div class="sp-history-detail">Date: ${t.transfer_date || '-'}</div>
            ${t.to_school ? `<div class="sp-history-detail">To School: ${esc(t.to_school)}</div>` : ''}
            ${t.reason ? `<div class="sp-history-detail">Reason: ${esc(t.reason)}</div>` : ''}
            ${t.remarks ? `<div class="sp-history-detail">Remarks: ${esc(t.remarks)}</div>` : ''}
          </div>
        `).join('');
      } else {
        transferContainer.innerHTML = '<div class="sp-no-records"><div class="sp-no-records-icon">🔄</div><div>No transfer records available</div></div>';
      }

      // Reset to overview tab
      document.querySelectorAll('#screen-student-profile .tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('#screen-student-profile .tab-content').forEach(tc => tc.style.display = 'none');
      const firstTab = document.querySelector('#screen-student-profile .tab-btn');
      if (firstTab) {
        firstTab.classList.add('active');
        const firstContent = document.getElementById('tab-sp-overview');
        if (firstContent) firstContent.style.display = 'block';
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
    } catch (err) { console.error('[APP_ERROR]', err.message); }
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

      const rows = students.map(s => {
        const statuses = ['Present', 'Absent', 'Late', 'Leave'];
        const options = statuses.map(st => {
          const sel = s.status === st || (!s.status && st === 'Present') ? 'selected' : '';
          return `<option value="${st}" ${sel}>${st}</option>`;
        }).join('');

        return `
          <tr data-student-id="${s.id}">
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td>
              <div style="display:flex; align-items:center; gap:10px;">
                <img src="${imgSrc(s.photo, 'school_assets/school_logo.png')}" style="width:30px; height:30px; border-radius:50%; object-fit:cover;">
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
              <input type="text" class="form-control att-row-time" style="width:100px; padding:6px 12px; text-align:center;" value="${s.time || new Date().toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true})}" placeholder="hh:mm AM">
            </td>
          </tr>
        `;
      });
      tbody.innerHTML = rows.join('');

      document.getElementById('att-grid-actions').style.display = 'block';

    } catch (e) { console.error('[APP_ERROR]', e.message); }
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

      if (status !== 'Leave') {
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
    } catch (err) { console.error('[APP_ERROR]', err.message); }
  });

  // Webcam QR Scanner logic
  const btnStartScanner = document.getElementById('btn-start-scanner');
  const btnStopScanner = document.getElementById('btn-stop-scanner');
  const btnFlipCamera = document.getElementById('btn-flip-camera');
  const scanHistoryTable = document.querySelector('#table-scan-history tbody');
  const scanFeedback = document.getElementById('scan-feedback-container');
  let currentFacing = 'environment'; // Default to back camera

  btnStartScanner.addEventListener('click', () => {
    if (html5QrcodeScanner) return;

    scanFeedback.style.display = 'none';
    html5QrcodeScanner = new Html5Qrcode('reader');
    
    html5QrcodeScanner.start(
      { facingMode: currentFacing },
      {
        fps: 10,
        qrbox: { width: 250, height: 250 }
      },
      async (decodedText) => {
        // Trim whitespace from decoded text
        const scanValue = (decodedText || '').trim();
        if (!scanValue) return;

        // Prevent duplicate rapid scans of the same code within 3 seconds
        const now = Date.now();
        if (window._lastScanValue === scanValue && (now - (window._lastScanTime || 0)) < 3000) return;
        window._lastScanValue = scanValue;
        window._lastScanTime = now;

        try {
          const dateStr = new Date().toISOString().split('T')[0];
          const result = await apiCall('/attendance/scan', 'POST', { scanValue, date: dateStr });
          
          playBeep('success');
          showToast(result.message);

          document.getElementById('scan-name').innerText = result.student.name;
          document.getElementById('scan-roll-class').innerText = `Roll No: ${result.student.roll_no || '-'} | Class: ${result.student.class_name}`;
          document.getElementById('scan-time').innerText = `Checked in: ${result.student.time}`;
          document.getElementById('scan-photo').src = imgSrc(result.student.photo);
          scanFeedback.style.display = 'block';

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
          showToast(`Scan failed: ${err.message}`, true);
        }
      },
      (errorMessage) => {
        // Scanner verbose error, ignore
      }
    ).catch(err => {
      showToast(`Camera error: ${err}`, true);
    });

    btnFlipCamera.style.display = 'inline-block';
  });

  // Flip Camera button
  btnFlipCamera.addEventListener('click', async () => {
    if (!html5QrcodeScanner) return;
    currentFacing = currentFacing === 'environment' ? 'user' : 'environment';
    try {
      await html5QrcodeScanner.stop();
      html5QrcodeScanner = null;
      document.getElementById('reader').innerHTML = '';
      btnStartScanner.click(); // Restart with new facing
    } catch (e) {
      showToast('Could not flip camera', true);
    }
  });

  function stopQrScanner() {
    if (html5QrcodeScanner) {
      html5QrcodeScanner.stop().then(() => {
        html5QrcodeScanner = null;
        document.getElementById('reader').innerHTML = '';
        btnFlipCamera.style.display = 'none';
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

      const rows = Object.keys(studentLogs).map(id => {
        const student = studentLogs[id];
        
        student.records.sort((a,b) => new Date(a.date) - new Date(b.date));
        const pills = student.records.map(r => {
          const day = r.date.split('-')[2];
          const badgeClass = r.status === 'Present' ? 'status-present' : (r.status === 'Absent' ? 'status-unpaid' : 'status-partial');
          return `<span class="status-badge ${badgeClass}" style="margin:2px; font-size:0.7rem;" title="${r.date}">${day}: ${r.status.substring(0, 1)}</span>`;
        }).join('');

        return `
          <tr>
            <td><strong>${student.roll_no || '-'}</strong></td>
            <td><strong>${student.name}</strong></td>
            <td><div style="display:flex; flex-wrap:wrap;">${pills}</div></td>
          </tr>
        `;
      });
      tbody.innerHTML = rows.join('');

    } catch (e) { console.error('[APP_ERROR]', e.message); }
  });

  // ==========================================
  // MODULE: TOTAL ATTENDANCE & HOLIDAYS
  // ==========================================

  // Load session start date on tab open
  async function loadSessionInfo() {
    try {
      const data = await apiCall('/attendance/session-info');
      document.getElementById('att-session-start').value = data.session_start_date || '';
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // Save session start date
  document.getElementById('btn-save-session-start').addEventListener('click', async () => {
    const date = document.getElementById('att-session-start').value;
    try {
      const res = await apiCall('/attendance/session-info', 'POST', { session_start_date: date });
      showToast(res.message);
    } catch (e) { showToast('Failed to save: ' + e.message, true); }
  });

  // Add holiday
  document.getElementById('btn-add-holiday').addEventListener('click', async () => {
    const date = document.getElementById('att-holiday-date').value;
    const name = document.getElementById('att-holiday-name').value.trim();
    if (!date || !name) {
      showToast('Date and Holiday Name are required', true);
      return;
    }
    try {
      const res = await apiCall('/attendance/holidays', 'POST', { date, name, type: 'Holiday' });
      showToast(res.message);
      document.getElementById('att-holiday-date').value = '';
      document.getElementById('att-holiday-name').value = '';
      loadHolidaysList();
    } catch (e) { showToast('Failed: ' + e.message, true); }
  });

  // Load holidays list
  async function loadHolidaysList() {
    try {
      const holidays = await apiCall('/attendance/holidays');
      const tbody = document.querySelector('#table-holidays-list tbody');
      tbody.innerHTML = '';
      if (holidays.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted);">No holidays marked yet</td></tr>';
        return;
      }
      tbody.innerHTML = holidays.map(h => `
        <tr>
          <td><strong>${h.date}</strong></td>
          <td>${h.name}</td>
          <td><span class="status-badge status-partial">${h.type || 'Holiday'}</span></td>
          <td>
            <button class="btn btn-danger btn-sm btn-delete-holiday" data-id="${h.id}" title="Remove Holiday">✕</button>
          </td>
        </tr>
      `).join('');

      // Attach delete handlers
      tbody.querySelectorAll('.btn-delete-holiday').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (!confirm('Remove this holiday?')) return;
          try {
            await apiCall(`/attendance/holidays/${btn.dataset.id}`, 'DELETE');
            showToast('Holiday removed');
            loadHolidaysList();
          } catch (e) { showToast('Failed: ' + e.message, true); }
        });
      });
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // Load class/section for total attendance tab
  document.querySelector('[data-tab="att-total"]').addEventListener('click', () => {
    loadClassesList();
    loadSessionInfo();
    loadHolidaysList();
    document.getElementById('att-total-month').value = new Date().toISOString().slice(0, 7);
  });

  // Section dropdown for total attendance
  document.getElementById('att-total-class').addEventListener('change', async (e) => {
    const cls = e.target.value;
    const secSelect = document.getElementById('att-total-sec');
    secSelect.innerHTML = '<option value="">All Sections</option>';
    if (!cls) return;
    try {
      const sections = await apiCall(`/students/sections/${cls}`);
      sections.forEach(s => {
        secSelect.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`;
      });
      secSelect.innerHTML += '<option value="No Section">No Section</option>';
    } catch (err) { console.error('[APP_ERROR]', err.message); }
  });

  // Calculate Total Attendance
  document.getElementById('btn-load-total-att').addEventListener('click', async () => {
    const cls = document.getElementById('att-total-class').value;
    const sec = document.getElementById('att-total-sec').value;
    const month = document.getElementById('att-total-month').value;

    if (!cls) {
      showToast('Please select a class', true);
      return;
    }

    try {
      let url = `/attendance/total?class_name=${encodeURIComponent(cls)}&month=${month}`;
      if (sec) url += `&section_name=${encodeURIComponent(sec)}`;

      const data = await apiCall(url);

      // Show summary cards
      document.getElementById('att-total-summary').style.display = 'block';
      document.getElementById('total-att-session').textContent = data.session_start_date || 'Not Set';
      document.getElementById('total-att-days').textContent = data.total_school_days;
      document.getElementById('total-att-holidays').textContent = data.holidays_count;
      document.getElementById('total-att-max').textContent = data.total_school_days * 2;

      // Render table
      const tbody = document.querySelector('#table-total-attendance tbody');
      tbody.innerHTML = '';

      if (data.students.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center;">No students found</td></tr>';
        return;
      }

      const maxPossible = data.total_school_days * 2;
      tbody.innerHTML = data.students.map(s => {
        const pct = maxPossible > 0 ? ((s.total_attendance_count / maxPossible) * 100).toFixed(1) : 0;
        const pctColor = pct >= 75 ? 'var(--success)' : (pct >= 50 ? 'var(--warning)' : 'var(--danger)');
        return `
          <tr>
            <td><strong>${s.roll_no || '-'}</strong></td>
            <td>${s.name}</td>
            <td><span class="status-badge status-present">${s.total_present}</span></td>
            <td><span class="status-badge status-partial">${s.total_late}</span></td>
            <td><strong style="color: var(--primary); font-size: 1.1rem;">${s.total_attendance_count}</strong></td>
            <td><span class="status-badge status-absent">${s.total_absent}</span></td>
            <td><strong style="color: ${pctColor};">${pct}%</strong></td>
          </tr>
        `;
      }).join('');

    } catch (e) { showToast('Failed: ' + e.message, true); }
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
    document.querySelectorAll('#screen-fees .fee-option-panel').forEach(panel => {
      panel.style.display = 'none';
    });
  }

  // Dashboard card clicks to show target panel
  document.querySelectorAll('#screen-fees .fees-dash-card').forEach(card => {
    card.addEventListener('click', () => {
      const targetOpt = card.getAttribute('data-opt');
      const dash = document.getElementById('fees-dashboard-view');
      if (dash) dash.style.display = 'none';
      document.querySelectorAll('#screen-fees .fee-option-panel').forEach(p => p.style.display = 'none');
      
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
  const feePayClass = document.getElementById('fee-pay-class');
  if (feePayClass) {
    feePayClass.addEventListener('change', () => {
      updateSectionDropdown('fee-pay-class', 'fee-pay-section', true);
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
    } catch (err) { console.error('[APP_ERROR]', err.message); }
  }

  // Load configuration details for a specific option panel
  function loadFeePanelData(opt) {
    const currentYear = new Date().getFullYear();
    const currentMonth = new Date().toLocaleString('en-US', { month: 'long' });

    if (opt === 'pay-fee') {
      // Initialize pay-fee filters
      invalidateClassCache();
      loadClassesList();
      const payYearSelect = document.getElementById('fee-pay-year');
      if (payYearSelect) {
        payYearSelect.innerHTML = '';
        for (let y = currentYear; y >= currentYear - 5; y--) {
          payYearSelect.innerHTML += `<option value="${y}">${y}</option>`;
        }
        payYearSelect.value = currentYear;
      }
      const payMonthSelect = document.getElementById('fee-pay-month');
      if (payMonthSelect) payMonthSelect.value = currentMonth;
      const payClassSelect = document.getElementById('fee-pay-class');
      if (payClassSelect) payClassSelect.value = 'All Classes';
      updateSectionDropdown('fee-pay-class', 'fee-pay-section', true);
      // Auto-load unpaid ledgers when pay-fee panel opens
      const paySearchBtn = document.getElementById('btn-search-pay-ledger');
      if (paySearchBtn) paySearchBtn.click();
    }
    else if (opt === 'fee-history') {
      // Refresh class dropdown to ensure it's always populated
      invalidateClassCache();
      loadClassesList();
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
      // Initialize slip month
      const slipMonthSelect = document.getElementById('slip-month');
      if (slipMonthSelect) slipMonthSelect.value = currentMonth;
      // Reset slip class and containers
      const slipClassSelect = document.getElementById('slip-class');
      if (slipClassSelect) slipClassSelect.value = '';
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
          const opt = document.createElement('option');
          opt.value = y;
          opt.textContent = y;
          if (y === currentYear) opt.selected = true;
          yearSelect.appendChild(opt);
        }
      }
      const monthSelect = document.getElementById('analytics-filter-month');
      if (monthSelect) {
        const opts = monthSelect.options;
        for (let i = 0; i < opts.length; i++) {
          if (opts[i].text === currentMonth) {
            opts[i].selected = true;
            break;
          }
        }
      }
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

      const rows = fees.map(f => `
          <tr>
            <td><strong>${f.class_name}</strong></td>
            <td><strong>${f.monthly_fee.toLocaleString()} PKR</strong></td>
          </tr>
      `);
      tbody.innerHTML = rows.join('');
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
        invalidateClassCache();
        formFeeSetup.reset();
        loadClassFeeRules();
      } catch (err) { console.error('[APP_ERROR]', err.message); }
    });
  }

  // Search Pending Invoices (Pay Fee)
  const btnSearchPayLedger = document.getElementById('btn-search-pay-ledger');
  if (btnSearchPayLedger) {
    btnSearchPayLedger.addEventListener('click', async () => {
      const search = document.getElementById('fee-pay-search').value.trim();
      const status = document.getElementById('fee-pay-filter-status').value;
      const cls = document.getElementById('fee-pay-class').value;
      const sec = document.getElementById('fee-pay-section').value;
      const month = document.getElementById('fee-pay-month').value;
      const year = document.getElementById('fee-pay-year').value;

      let endpoint = '/fees/ledger?';
      if (status) endpoint += `status=${status}&`;
      if (cls && cls !== 'All Classes') endpoint += `class_name=${encodeURIComponent(cls)}&`;
      if (sec && sec !== 'All Sections') endpoint += `section_name=${encodeURIComponent(sec)}&`;
      if (month) endpoint += `month=${encodeURIComponent(month)}&`;
      if (year) endpoint += `year=${year}&`;

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

        const rows = filtered.map(l => {
          const remaining = l.total_payable - l.paid_amount;
          let badgeClass = 'status-unpaid';
          if (l.status === 'Partial') badgeClass = 'status-partial';

          return `
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
        tbody.innerHTML = rows.join('');

        attachFeePaymentFormEvents();
      } catch (e) { console.error('[APP_ERROR]', e.message); }
    });
  }

  // Collect modal form bindings — use event delegation
  const modalTx = document.getElementById('modal-transaction');
  let _feeTxDelegationBound = false;
  function attachFeePaymentFormEvents() {
    if (_feeTxDelegationBound) return;
    _feeTxDelegationBound = true;
    
    // Event delegation on the ledger table body
    const ledgerBody = document.querySelector('#table-unpaid-ledgers tbody');
    if (ledgerBody) {
      ledgerBody.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-record-tx');
        if (!btn) return;
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
    }
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
      } catch (err) { console.error('[APP_ERROR]', err.message); }
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
    if (!month || !year) return;

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

      const rows = data.map(l => {
        const hasLedger = l.ledger_id !== null;
        let badge = '-';
        if (l.status === 'Paid') badge = '<span class="status-badge status-present">PAID</span>';
        else if (l.status === 'Partial') badge = '<span class="status-badge status-partial">PARTIAL</span>';
        else if (l.status === 'Unpaid') badge = '<span class="status-badge status-absent">UNPAID</span>';

        const actionBtn = hasLedger
          ? `<button class="btn btn-danger btn-sm btn-delete-history-ledger" data-id="${l.ledger_id}">Delete</button>`
          : `<button class="btn btn-outline btn-success btn-sm btn-generate-history-ledger" data-student-id="${l.student_id}">Generate</button>`;

        return `
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
      tbody.innerHTML = rows.join('');

      // Event delegation for generate/delete buttons
      tbody.onclick = async (e) => {
        const genBtn = e.target.closest('.btn-generate-history-ledger');
        if (genBtn) {
          const student_id = genBtn.getAttribute('data-student-id');
          try {
            const res = await apiCall('/fees/generate-single', 'POST', { student_id, month, year });
            showToast(res.message);
            refreshAllFeeViews();
          } catch (err) { console.error('[APP_ERROR]', err.message); }
          return;
        }
        const delBtn = e.target.closest('.btn-delete-history-ledger');
        if (delBtn) {
          const ledger_id = delBtn.getAttribute('data-id');
          if (!confirm('Are you sure you want to delete this student\'s ledger for this month?')) return;
          try {
            const res = await apiCall(`/fees/ledger/${ledger_id}`, 'DELETE');
            showToast(res.message);
            refreshAllFeeViews();
          } catch (err) { console.error('[APP_ERROR]', err.message); }
          return;
        }
      };

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
      } catch (e) { console.error('[APP_ERROR]', e.message); }
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
      } catch (e) { console.error('[APP_ERROR]', e.message); }
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
      } catch (e) { console.error('[APP_ERROR]', e.message); }
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

      const rows = list.map(s => {
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

        return `
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
      tbody.innerHTML = rows.join('');

      // Event delegation for waiver type change and save buttons
      tbody.onchange = (e) => {
        const sel = e.target.closest('.val-waiver-type');
        if (sel) {
          const row = sel.closest('tr');
          const type = sel.value;
          const valInput = row.querySelector('.val-discount-value');
          if (type === 'none' || type === 'free') {
            valInput.value = 0;
            valInput.disabled = true;
          } else {
            valInput.disabled = false;
          }
        }
      };

      tbody.onclick = async (e) => {
        const btn = e.target.closest('.btn-save-student-fee');
        if (!btn) return;
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
        } catch (err) { console.error('[APP_ERROR]', err.message); }
      };

    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
    const studentPhoto = imgSrc(d.student.photo, '');

    // Only include months that have actual ledger data (not null)
    const activeMonths = allMonths.filter(m => d.monthlyFee[m] !== null && d.monthlyFee[m] !== undefined);

    if (activeMonths.length === 0) {
      return `
        <div class="fee-slip">
          <div class="slip-header">
            <img src="${imgSrc(schoolData.logo, 'school_assets/school_logo.png')}" class="slip-logo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect width=%2236%22 height=%2236%22 fill=%22%236366f1%22/><text x=%2218%22 y=%2224%22 font-size=%2216%22 fill=%22white%22 text-anchor=%22middle%22>SS</text></svg>'">
            <div class="slip-header-text">
              <h2>${schoolData.name || 'School Name'}</h2>
              <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
            </div>
          </div>
          <div class="slip-student-row">
            ${studentPhoto ? `<img src="${studentPhoto}" style="width:45px; height:55px; border-radius:4px; object-fit:cover; border:1px solid #ccc;" onerror="this.style.display='none'">` : ''}
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
          <img src="${imgSrc(schoolData.logo, 'school_assets/school_logo.png')}" class="slip-logo" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 36 36%22><rect width=%2236%22 height=%2236%22 fill=%22%236366f1%22/><text x=%2218%22 y=%2224%22 font-size=%2216%22 fill=%22white%22 text-anchor=%22middle%22>SS</text></svg>'">
          <div class="slip-header-text">
            <h2>${schoolData.name || 'School Name'}</h2>
            <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
          </div>
        </div>
        <div class="slip-student-row">
          ${studentPhoto ? `<img src="${studentPhoto}" style="width:45px; height:55px; border-radius:4px; object-fit:cover; border:1px solid #ccc;" onerror="this.style.display='none'">` : ''}
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // ==========================================
  // FEE ANALYTICS LOGIC (Option 6)
  // ==========================================
  async function refreshFeeAnalytics() {
    const month = document.getElementById('analytics-filter-month').value;
    const year = document.getElementById('analytics-filter-year').value;
    if (!month || !year) return;

    try {
      const data = await apiCall(`/fees/analytics?month=${month}&year=${year}`);
      const tbody = document.querySelector('#table-analytics-class-summary tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      if (data.classWise.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">No data found.</td></tr>';
        return;
      }

      const rows = data.classWise.map(c => {
        let badgeColor = '#ff5252';
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

        return `
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
      tbody.innerHTML = rows.join('');

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
      const statSchoolOutstandingAll = document.getElementById('stat-school-outstanding-all');
      if (statSchoolOutstandingAll) statSchoolOutstandingAll.innerText = `${(data.schoolWise.total_outstanding_all || 0).toLocaleString()} PKR`;

      // Render Chart.js Bar Chart
      renderAnalyticsChart(data.classWise);

    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  const btnRefreshAnalytics = document.getElementById('btn-refresh-analytics');
  if (btnRefreshAnalytics) {
    btnRefreshAnalytics.addEventListener('click', refreshFeeAnalytics);
  }

  async function renderAnalyticsChart(classWiseData) {
    const chartCanvas = document.getElementById('chart-collection-rate');
    if (!chartCanvas) return;

    if (collectionChartInstance) {
      collectionChartInstance.destroy();
    }

    await window._loadChartJs();
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

        const rows = list.map(l => {
          let badge = 'status-unpaid';
          if (l.status === 'Paid') badge = 'status-present';
          else if (l.status === 'Partial') badge = 'status-partial';

          return `
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
        tbody.innerHTML = rows.join('');
      } catch (e) { console.error('[APP_ERROR]', e.message); }
    });
  }


  // ==========================================
  // MODULE: FEE SLIP
  // ==========================================

  const slipStudentsCache = [];

  const btnGenerateClassSlips = document.getElementById('btn-generate-class-slips');
  if (btnGenerateClassSlips) {
    btnGenerateClassSlips.addEventListener('click', async () => {
      const className = document.getElementById('slip-class').value;
      const year = document.getElementById('slip-year').value;
      const month = document.getElementById('slip-month').value;
      if (!className) {
        showToast('Please select a class', true);
        return;
      }

      try {
        const students = await apiCall(`/students?class_name=${encodeURIComponent(className)}`);
        slipStudentsCache.length = 0;
        const tbody = document.querySelector('#table-slip-students tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        if (students.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No students found in this class.</td></tr>';
          return;
        }

        students.forEach(s => slipStudentsCache.push(s));
        const rows = students.map(s => `
            <tr>
              <td>${s.roll_no || 'N/A'}</td>
              <td><strong>${s.name}</strong></td>
              <td>${s.class_name} ${s.section_name ? '(' + s.section_name + ')' : ''}</td>
              <td>${s.father_name || '-'}</td>
              <td>${s.family_head_id ? '<span style="color:var(--text-muted);font-size:0.8rem;">Linked (No Slip)</span>' : `<button class="btn btn-primary btn-sm btn-generate-slip" data-id="${s.id}">Generate Slip</button>`}</td>
            </tr>
          `);
        tbody.innerHTML = rows.join('');

        const nonLinkedStudents = slipStudentsCache.filter(s => !s.family_head_id);

        tbody.onclick = (e) => {
          const btn = e.target.closest('.btn-generate-slip');
          if (!btn) return;
          const studentId = btn.getAttribute('data-id');
          generateSlipsForStudents([slipStudentsCache.find(s => s.id == studentId)]);
        };

        if (nonLinkedStudents.length > 0) {
          generateSlipsForStudents([...nonLinkedStudents]);
        } else {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align: center;">No students with generated ledgers found in this class.</td></tr>';
        }
      } catch (e) {
        showToast('Failed to load students: ' + (e.message || 'Unknown error'), true);
      }
    });
  }

  function buildSlipHTML(studentData, schoolData, year) {
    const allMonths = ['Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec','Jan','Feb'];
    const d = studentData;
    const logoSrc = imgSrc(schoolData.logo, '');
    const studentPhoto = imgSrc(d.student.photo, '');

    // Only include months that have actual ledger data (not null)
    const activeMonths = allMonths.filter(m => d.monthlyFee[m] !== null && d.monthlyFee[m] !== undefined);

    if (activeMonths.length === 0) {
      return `
        <div class="fee-slip">
          <div class="slip-header">
            ${logoSrc ? `<img src="${logoSrc}" class="slip-logo">` : ''}
            <div class="slip-header-text">
              <h2>${schoolData.name || 'School Name'}</h2>
              <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
            </div>
          </div>
          <div class="slip-student-row">
            ${studentPhoto ? `<img src="${studentPhoto}" style="width:45px; height:55px; border-radius:4px; object-fit:cover; border:1px solid #ccc;" onerror="this.style.display='none'">` : ''}
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
          ${logoSrc ? `<img src="${logoSrc}" class="slip-logo">` : ''}
          <div class="slip-header-text">
            <h2>${schoolData.name || 'School Name'}</h2>
            <p>Contact: ${schoolData.phone || '-'} | Reg No: ${schoolData.reg || '-'}</p>
          </div>
        </div>
        <div class="slip-student-row">
          ${studentPhoto ? `<img src="${studentPhoto}" style="width:45px; height:55px; border-radius:4px; object-fit:cover; border:1px solid #ccc;" onerror="this.style.display='none'">` : ''}
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
      const images = printWindow.document.querySelectorAll('img');
      if (images.length === 0) {
        printWindow.print();
      } else {
        let loaded = 0;
        images.forEach(img => {
          if (img.complete) {
            loaded++;
            if (loaded === images.length) printWindow.print();
          } else {
            img.onload = () => {
              loaded++;
              if (loaded === images.length) printWindow.print();
            };
            img.onerror = () => {
              loaded++;
              if (loaded === images.length) printWindow.print();
            };
          }
        });
      }
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
  // MODULE: TRANSPORT MANAGEMENT
  // ==========================================

  let transportVehiclesCache = [];
  let transportRoutesCache = [];

  async function loadTransportData() {
    try {
      const [stats, vehicles, drivers, routes, assignments] = await Promise.all([
        apiCall('/transport/stats').catch(() => ({})),
        apiCall('/transport/vehicles').catch(() => []),
        apiCall('/transport/drivers').catch(() => []),
        apiCall('/transport/routes').catch(() => []),
        apiCall('/transport/assignments').catch(() => [])
      ]);

      transportVehiclesCache = vehicles;
      transportRoutesCache = routes;

      // Update stats cards
      document.getElementById('ts-total-vehicles').textContent = stats.totalVehicles || 0;
      document.getElementById('ts-total-drivers').textContent = stats.totalDrivers || 0;
      document.getElementById('ts-total-routes').textContent = stats.totalRoutes || 0;
      document.getElementById('ts-total-students').textContent = stats.totalStudents || 0;
      document.getElementById('ts-monthly-revenue').textContent = 'Rs ' + (stats.monthlyRevenue || 0).toLocaleString();

      // Populate vehicle dropdowns
      const vehicleSelects = ['driver-vehicle', 'route-vehicle', 'assign-vehicle'];
      vehicleSelects.forEach(id => {
        const sel = document.getElementById(id);
        if (!sel) return;
        const firstOpt = id === 'assign-vehicle' ? '<option value="">-- Select Vehicle --</option>' : '<option value="">-- No Vehicle --</option>';
        sel.innerHTML = firstOpt;
        vehicles.filter(v => v.status === 'Active').forEach(v => {
          sel.innerHTML += `<option value="${v.id}">${v.name} (${v.plate_number})</option>`;
        });
      });

      // Populate route dropdown
      const routeSel = document.getElementById('assign-route');
      if (routeSel) {
        routeSel.innerHTML = '<option value="">-- Select Route --</option>';
        routes.filter(r => r.status === 'Active').forEach(r => {
          routeSel.innerHTML += `<option value="${r.id}">${r.name}</option>`;
        });
      }

      // Populate student dropdown for assignment
      const studentSel = document.getElementById('assign-student');
      if (studentSel) {
        studentSel.innerHTML = '<option value="">-- Select Student --</option>';
        const students = await apiCall('/students').catch(() => []);
        students.forEach(s => {
          const assigned = assignments.find(a => a.student_id == s.id && a.status === 'Active');
          const标记 = assigned ? ' [ASSIGNED]' : '';
          studentSel.innerHTML += `<option value="${s.id}"${assigned ? ' disabled' : ''}>${s.name} (${s.class_name})${标记}</option>`;
        });
      }

      renderVehiclesTable(vehicles);
      renderDriversTable(drivers);
      renderRoutesTable(routes);
      renderAssignmentsTable(assignments);
      renderTransportFees(assignments);
    } catch (err) { console.error('[APP_ERROR]', err.message); }
  }

  function renderVehiclesTable(vehicles) {
    const tbody = document.getElementById('table-vehicles');
    if (!tbody) return;
    if (vehicles.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="padding: 16px; text-align: center; color: var(--text-muted);">No vehicles added yet.</td></tr>';
      return;
    }
    tbody.innerHTML = vehicles.map(v => `
      <tr>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${v.name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${v.plate_number || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${v.type || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${v.capacity || 0}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">Rs ${(v.monthly_fee || 0).toLocaleString()}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;"><span style="padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; background: ${v.status === 'Active' ? 'rgba(34,197,94,0.15); color: #22c55e' : v.status === 'Maintenance' ? 'rgba(234,179,8,0.15); color: #eab308' : 'rgba(239,68,68,0.15); color: #ef4444'};">${v.status}</span></td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">
          <button class="btn btn-outline btn-sm" onclick="editTransportVehicle(${v.id})" style="margin-right:5px;">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTransportVehicle(${v.id})">Del</button>
        </td>
      </tr>
    `).join('');
  }

  function renderDriversTable(drivers) {
    const tbody = document.getElementById('table-drivers');
    if (!tbody) return;
    if (drivers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding: 16px; text-align: center; color: var(--text-muted);">No drivers added yet.</td></tr>';
      return;
    }
    tbody.innerHTML = drivers.map(d => `
      <tr>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${d.name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${d.phone || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${d.license_number || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${d.vehicle_name ? d.vehicle_name + ' (' + d.vehicle_plate + ')' : 'Unassigned'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;"><span style="padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; background: ${d.status === 'Active' ? 'rgba(34,197,94,0.15); color: #22c55e' : 'rgba(239,68,68,0.15); color: #ef4444'};">${d.status}</span></td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">
          <button class="btn btn-outline btn-sm" onclick="editTransportDriver(${d.id})" style="margin-right:5px;">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTransportDriver(${d.id})">Del</button>
        </td>
      </tr>
    `).join('');
  }

  function renderRoutesTable(routes) {
    const tbody = document.getElementById('table-routes');
    if (!tbody) return;
    if (routes.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="padding: 16px; text-align: center; color: var(--text-muted);">No routes created yet.</td></tr>';
      return;
    }
    tbody.innerHTML = routes.map(r => `
      <tr>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${r.name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${r.vehicle_name || 'Unassigned'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px; max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${(r.pickup_locations || []).join(', ')}">${(r.pickup_locations || []).join(', ') || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px; max-width: 150px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${(r.drop_locations || []).join(', ')}">${(r.drop_locations || []).join(', ') || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">Rs ${(r.monthly_fee || 0).toLocaleString()}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">
          <button class="btn btn-outline btn-sm" onclick="editTransportRoute(${r.id})" style="margin-right:5px;">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="deleteTransportRoute(${r.id})">Del</button>
        </td>
      </tr>
    `).join('');
  }

  function renderAssignmentsTable(assignments) {
    const tbody = document.getElementById('table-assignments');
    if (!tbody) return;
    const active = assignments.filter(a => a.status === 'Active');
    if (active.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="padding: 16px; text-align: center; color: var(--text-muted);">No students assigned yet.</td></tr>';
      return;
    }
    tbody.innerHTML = active.map(a => `
      <tr>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.student_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.class_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.vehicle_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.route_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.pickup_point || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">Rs ${(a.monthly_fee || 0).toLocaleString()}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;"><span style="padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; background: rgba(34,197,94,0.15); color: #22c55e;">${a.status}</span></td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">
          <button class="btn btn-danger btn-sm" onclick="removeTransportAssignment(${a.id})">Remove</button>
        </td>
      </tr>
    `).join('');
  }

  function renderTransportFees(assignments) {
    const active = assignments.filter(a => a.status === 'Active');
    const totalRevenue = active.reduce((sum, a) => sum + (a.monthly_fee || 0), 0);
    const avgFee = active.length > 0 ? Math.round(totalRevenue / active.length) : 0;

    const tfAssigned = document.getElementById('tf-total-assigned');
    const tfRevenue = document.getElementById('tf-total-revenue');
    const tfAvg = document.getElementById('tf-avg-fee');
    if (tfAssigned) tfAssigned.textContent = active.length;
    if (tfRevenue) tfRevenue.textContent = 'Rs ' + totalRevenue.toLocaleString();
    if (tfAvg) tfAvg.textContent = 'Rs ' + avgFee.toLocaleString();

    const tbody = document.getElementById('table-transport-fees');
    if (!tbody) return;
    if (active.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="padding: 16px; text-align: center; color: var(--text-muted);">No transport fee data.</td></tr>';
      return;
    }
    tbody.innerHTML = active.map(a => `
      <tr>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.student_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.class_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">${a.vehicle_name || '-'}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;">Rs ${(a.monthly_fee || 0).toLocaleString()}</td>
        <td style="border: 1px solid rgba(255,255,255,0.1); padding: 10px;"><span style="padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; background: rgba(34,197,94,0.15); color: #22c55e;">${a.status}</span></td>
      </tr>
    `).join('');
  }

  // --- Vehicle CRUD ---
  document.getElementById('form-vehicle').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('vehicle-edit-id').value;
    const data = {
      name: document.getElementById('vehicle-name').value.trim(),
      plate_number: document.getElementById('vehicle-plate').value.trim(),
      type: document.getElementById('vehicle-type').value,
      capacity: parseInt(document.getElementById('vehicle-capacity').value) || 0,
      monthly_fee: parseFloat(document.getElementById('vehicle-fee').value) || 0,
      status: document.getElementById('vehicle-status').value
    };
    try {
      if (editId) {
        await apiCall('/transport/vehicles/' + editId, 'PUT', data);
        showToast('Vehicle updated');
      } else {
        await apiCall('/transport/vehicles', 'POST', data);
        showToast('Vehicle added');
      }
      document.getElementById('form-vehicle').reset();
      document.getElementById('vehicle-edit-id').value = '';
      document.getElementById('btn-save-vehicle').textContent = 'Save Vehicle';
      loadTransportData();
    } catch (err) { showToast('Error: ' + err.message, true); }
  });

  window.editTransportVehicle = async function(id) {
    const vehicles = await apiCall('/transport/vehicles').catch(() => []);
    const v = vehicles.find(x => x.id === id);
    if (!v) return;
    document.getElementById('vehicle-edit-id').value = v.id;
    document.getElementById('vehicle-name').value = v.name || '';
    document.getElementById('vehicle-plate').value = v.plate_number || '';
    document.getElementById('vehicle-type').value = v.type || 'Bus';
    document.getElementById('vehicle-capacity').value = v.capacity || 0;
    document.getElementById('vehicle-fee').value = v.monthly_fee || 0;
    document.getElementById('vehicle-status').value = v.status || 'Active';
    document.getElementById('btn-save-vehicle').textContent = 'Update Vehicle';
  };

  window.deleteTransportVehicle = async function(id) {
    if (!confirm('Delete this vehicle?')) return;
    try {
      await apiCall('/transport/vehicles/' + id, 'DELETE');
      showToast('Vehicle deleted');
      loadTransportData();
    } catch (err) { showToast(err.message, true); }
  };

  // --- Driver CRUD ---
  document.getElementById('form-driver').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('driver-edit-id').value;
    const data = {
      name: document.getElementById('driver-name').value.trim(),
      phone: document.getElementById('driver-phone').value.trim(),
      license_number: document.getElementById('driver-license').value.trim(),
      address: document.getElementById('driver-address').value.trim(),
      vehicle_id: document.getElementById('driver-vehicle').value || null,
      status: document.getElementById('driver-status').value
    };
    try {
      if (editId) {
        await apiCall('/transport/drivers/' + editId, 'PUT', data);
        showToast('Driver updated');
      } else {
        await apiCall('/transport/drivers', 'POST', data);
        showToast('Driver added');
      }
      document.getElementById('form-driver').reset();
      document.getElementById('driver-edit-id').value = '';
      document.getElementById('btn-save-driver').textContent = 'Save Driver';
      loadTransportData();
    } catch (err) { showToast('Error: ' + err.message, true); }
  });

  window.editTransportDriver = async function(id) {
    const drivers = await apiCall('/transport/drivers').catch(() => []);
    const d = drivers.find(x => x.id === id);
    if (!d) return;
    document.getElementById('driver-edit-id').value = d.id;
    document.getElementById('driver-name').value = d.name || '';
    document.getElementById('driver-phone').value = d.phone || '';
    document.getElementById('driver-license').value = d.license_number || '';
    document.getElementById('driver-address').value = d.address || '';
    document.getElementById('driver-status').value = d.status || 'Active';
    // Set vehicle select
    const vSel = document.getElementById('driver-vehicle');
    if (d.vehicle_id) {
      for (let i = 0; i < vSel.options.length; i++) {
        if (vSel.options[i].value == d.vehicle_id) { vSel.selectedIndex = i; break; }
      }
    } else {
      vSel.selectedIndex = 0;
    }
    document.getElementById('btn-save-driver').textContent = 'Update Driver';
  };

  window.deleteTransportDriver = async function(id) {
    if (!confirm('Delete this driver?')) return;
    try {
      await apiCall('/transport/drivers/' + id, 'DELETE');
      showToast('Driver deleted');
      loadTransportData();
    } catch (err) { showToast(err.message, true); }
  };

  // --- Route CRUD ---
  let routePickupCount = 0;
  let routeDropCount = 0;

  document.getElementById('btn-add-pickup').addEventListener('click', () => {
    routePickupCount++;
    const html = `<div style="display:flex; gap:8px; align-items:center;" id="pickup-row-${routePickupCount}">
      <input type="text" class="form-control route-pickup-input" placeholder="Pickup location" style="flex:1;">
      <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()">x</button>
    </div>`;
    document.getElementById('route-pickup-container').insertAdjacentHTML('beforeend', html);
  });

  document.getElementById('btn-add-drop').addEventListener('click', () => {
    routeDropCount++;
    const html = `<div style="display:flex; gap:8px; align-items:center;" id="drop-row-${routeDropCount}">
      <input type="text" class="form-control route-drop-input" placeholder="Drop location" style="flex:1;">
      <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()">x</button>
    </div>`;
    document.getElementById('route-drop-container').insertAdjacentHTML('beforeend', html);
  });

  document.getElementById('form-route').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('route-edit-id').value;
    const pickups = [];
    document.querySelectorAll('.route-pickup-input').forEach(inp => {
      if (inp.value.trim()) pickups.push(inp.value.trim());
    });
    const drops = [];
    document.querySelectorAll('.route-drop-input').forEach(inp => {
      if (inp.value.trim()) drops.push(inp.value.trim());
    });
    const data = {
      name: document.getElementById('route-name').value.trim(),
      vehicle_id: document.getElementById('route-vehicle').value || null,
      monthly_fee: parseFloat(document.getElementById('route-fee').value) || 0,
      status: document.getElementById('route-status').value,
      pickup_locations: pickups,
      drop_locations: drops
    };
    try {
      if (editId) {
        await apiCall('/transport/routes/' + editId, 'PUT', data);
        showToast('Route updated');
      } else {
        await apiCall('/transport/routes', 'POST', data);
        showToast('Route created');
      }
      document.getElementById('form-route').reset();
      document.getElementById('route-edit-id').value = '';
      document.getElementById('route-pickup-container').innerHTML = '';
      document.getElementById('route-drop-container').innerHTML = '';
      document.getElementById('btn-save-route').textContent = 'Save Route';
      loadTransportData();
    } catch (err) { showToast('Error: ' + err.message, true); }
  });

  window.editTransportRoute = async function(id) {
    const routes = await apiCall('/transport/routes').catch(() => []);
    const r = routes.find(x => x.id === id);
    if (!r) return;
    document.getElementById('route-edit-id').value = r.id;
    document.getElementById('route-name').value = r.name || '';
    document.getElementById('route-fee').value = r.monthly_fee || 0;
    document.getElementById('route-status').value = r.status || 'Active';
    // Set vehicle
    const vSel = document.getElementById('route-vehicle');
    if (r.vehicle_id) {
      for (let i = 0; i < vSel.options.length; i++) {
        if (vSel.options[i].value == r.vehicle_id) { vSel.selectedIndex = i; break; }
      }
    } else {
      vSel.selectedIndex = 0;
    }
    // Rebuild pickup/drop inputs
    const pickupContainer = document.getElementById('route-pickup-container');
    const dropContainer = document.getElementById('route-drop-container');
    pickupContainer.innerHTML = '';
    dropContainer.innerHTML = '';
    (r.pickup_locations || []).forEach(loc => {
      routePickupCount++;
      pickupContainer.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:8px; align-items:center;" id="pickup-row-${routePickupCount}"><input type="text" class="form-control route-pickup-input" placeholder="Pickup location" style="flex:1;" value="${loc}"><button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()">x</button></div>`);
    });
    (r.drop_locations || []).forEach(loc => {
      routeDropCount++;
      dropContainer.insertAdjacentHTML('beforeend', `<div style="display:flex; gap:8px; align-items:center;" id="drop-row-${routeDropCount}"><input type="text" class="form-control route-drop-input" placeholder="Drop location" style="flex:1;" value="${loc}"><button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove()">x</button></div>`);
    });
    document.getElementById('btn-save-route').textContent = 'Update Route';
  };

  window.deleteTransportRoute = async function(id) {
    if (!confirm('Delete this route?')) return;
    try {
      await apiCall('/transport/routes/' + id, 'DELETE');
      showToast('Route deleted');
      loadTransportData();
    } catch (err) { showToast(err.message, true); }
  };

  // --- Student Assignment ---
  document.getElementById('assign-route').addEventListener('change', async function() {
    const routeId = this.value;
    const pickupSel = document.getElementById('assign-pickup');
    const dropSel = document.getElementById('assign-drop');
    pickupSel.innerHTML = '<option value="">-- Select --</option>';
    dropSel.innerHTML = '<option value="">-- Select --</option>';
    if (!routeId) return;
    const routes = await apiCall('/transport/routes').catch(() => []);
    const route = routes.find(r => r.id == routeId);
    if (!route) return;
    (route.pickup_locations || []).forEach(loc => {
      pickupSel.innerHTML += `<option value="${loc}">${loc}</option>`;
    });
    (route.drop_locations || []).forEach(loc => {
      dropSel.innerHTML += `<option value="${loc}">${loc}</option>`;
    });
    // Auto-fill fee from route
    document.getElementById('assign-fee').value = route.monthly_fee || 0;
  });

  document.getElementById('assign-vehicle').addEventListener('change', async function() {
    const vehicleId = this.value;
    if (!vehicleId) return;
    const vehicles = await apiCall('/transport/vehicles').catch(() => []);
    const v = vehicles.find(x => x.id == vehicleId);
    if (v && v.monthly_fee) {
      document.getElementById('assign-fee').value = v.monthly_fee;
    }
  });

  document.getElementById('form-transport-assign').addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = {
      student_id: document.getElementById('assign-student').value,
      vehicle_id: document.getElementById('assign-vehicle').value || null,
      route_id: document.getElementById('assign-route').value || null,
      pickup_point: document.getElementById('assign-pickup').value || '',
      drop_point: document.getElementById('assign-drop').value || '',
      monthly_fee: parseFloat(document.getElementById('assign-fee').value) || 0,
      status: 'Active'
    };
    if (!data.student_id) { showToast('Please select a student', true); return; }
    try {
      await apiCall('/transport/assignments', 'POST', data);
      showToast('Student assigned to transport');
      document.getElementById('form-transport-assign').reset();
      loadTransportData();
    } catch (err) { showToast(err.message || 'Assignment failed', true); }
  });

  window.removeTransportAssignment = async function(id) {
    if (!confirm('Remove this student from transport?')) return;
    try {
      await apiCall('/transport/assignments/' + id, 'DELETE');
      showToast('Assignment removed');
      loadTransportData();
    } catch (err) { showToast(err.message, true); }
  };


  // ==========================================
  // MODULE: SALARY MANAGEMENT
  // ==========================================

  let salaryTeachersCache = [];

  document.querySelectorAll('.sal-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sal-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-saltab');
      document.querySelectorAll('.sal-tab-content').forEach(c => c.style.display = 'none');
      const target = document.getElementById(tab);
      if (target) target.style.display = 'block';
      if (tab === 'sal-setup') loadSalarySetup();
      if (tab === 'sal-pay') loadSalaryPayTab();
      if (tab === 'sal-history') loadSalaryHistoryTab();
      if (tab === 'sal-summary') { document.getElementById('sal-sum-year').value = new Date().getFullYear(); }
    });
  });

  async function loadSalarySetup() {
    try {
      const teachers = await apiCall('/salary/teachers');
      salaryTeachersCache = teachers;
      const configured = teachers.filter(t => t.salary_id).length;
      document.getElementById('sal-total-teachers').textContent = teachers.length;
      document.getElementById('sal-configured').textContent = configured;
      document.getElementById('sal-pending-count').textContent = teachers.length - configured;

      const body = document.getElementById('sal-setup-body');
      if (teachers.length === 0) {
        body.innerHTML = '<tr><td colspan="12" class="sp-no-records-row">No active teachers found</td></tr>';
        return;
      }
      body.innerHTML = teachers.map(t => `<tr>
        <td><strong>${t.name}</strong></td>
        <td>${t.subject || '-'}</td>
        <td>${t.phone || '-'}</td>
        <td>${t.qualification || '-'}</td>
        <td><input type="number" class="form-control sal-basic" data-id="${t.id}" value="${t.basic_salary || 0}" style="width:100px;"></td>
        <td><input type="number" class="form-control sal-house" data-id="${t.id}" value="${t.house_allowance || 0}" style="width:80px;"></td>
        <td><input type="number" class="form-control sal-medical" data-id="${t.id}" value="${t.medical_allowance || 0}" style="width:80px;"></td>
        <td><input type="number" class="form-control sal-transport" data-id="${t.id}" value="${t.transport_allowance || 0}" style="width:80px;"></td>
        <td><input type="number" class="form-control sal-other" data-id="${t.id}" value="${t.other_allowances || 0}" style="width:80px;"></td>
        <td><input type="number" class="form-control sal-deductions" data-id="${t.id}" value="${t.deductions || 0}" style="width:80px;"></td>
        <td><input type="number" class="form-control sal-tax" data-id="${t.id}" value="${t.tax || 0}" style="width:80px;"></td>
        <td><button class="btn btn-primary btn-sm" onclick="saveTeacherSalary(${t.id})">Save</button></td>
      </tr>`).join('');
    } catch (err) {
      showToast('Error loading teachers: ' + err.message, true);
    }
  }

  window.saveTeacherSalary = async function(teacherId) {
    try {
      const get = (cls) => parseFloat(document.querySelector(`.sal-${cls}[data-id="${teacherId}"]`).value) || 0;
      await apiCall('/salary/setup', 'POST', {
        teacher_id: teacherId,
        basic_salary: get('basic'),
        house_allowance: get('house'),
        medical_allowance: get('medical'),
        transport_allowance: get('transport'),
        other_allowances: get('other'),
        deductions: get('deductions'),
        tax: get('tax')
      });
      showToast('Salary structure saved');
      loadSalarySetup();
    } catch (err) { showToast(err.message, true); }
  };

  async function loadSalaryPayTab() {
    try {
      if (salaryTeachersCache.length === 0) {
        salaryTeachersCache = await apiCall('/salary/teachers');
      }
      const sel = document.getElementById('sal-pay-teacher');
      sel.innerHTML = '<option value="">-- Select Teacher --</option>' +
        salaryTeachersCache.filter(t => t.salary_id).map(t =>
          `<option value="${t.id}">${t.name} (${t.subject || 'N/A'})</option>`).join('');
      document.getElementById('sal-pay-year').value = new Date().getFullYear();
      const now = new Date();
      document.getElementById('sal-pay-month').selectedIndex = now.getMonth();

      sel.addEventListener('change', () => {
        const preview = document.getElementById('sal-pay-preview');
        const t = salaryTeachersCache.find(x => x.id == sel.value);
        if (t && t.salary_id) {
          const allow = (t.house_allowance||0) + (t.medical_allowance||0) + (t.transport_allowance||0) + (t.other_allowances||0);
          const ded = (t.deductions||0) + (t.tax||0);
          const net = (t.basic_salary||0) + allow - ded;
          document.getElementById('sal-preview-basic').textContent = 'Rs. ' + (t.basic_salary||0);
          document.getElementById('sal-preview-allow').textContent = 'Rs. ' + allow;
          document.getElementById('sal-preview-ded').textContent = 'Rs. ' + (t.deductions||0);
          document.getElementById('sal-preview-tax').textContent = 'Rs. ' + (t.tax||0);
          document.getElementById('sal-preview-net').textContent = net;
          preview.style.display = 'block';
        } else {
          preview.style.display = 'none';
        }
      });
    } catch (err) { showToast('Error: ' + err.message, true); }
  }

  document.getElementById('sal-pay-btn').addEventListener('click', async () => {
    const teacherId = document.getElementById('sal-pay-teacher').value;
    if (!teacherId) return showToast('Select a teacher first', true);
    if (!confirm('Confirm salary payment?')) return;
    try {
      const result = await apiCall('/salary/pay', 'POST', {
        teacher_id: parseInt(teacherId),
        month: document.getElementById('sal-pay-month').value,
        year: parseInt(document.getElementById('sal-pay-year').value),
        payment_method: document.getElementById('sal-pay-method').value,
        reference_no: document.getElementById('sal-pay-ref').value,
        remarks: document.getElementById('sal-pay-remarks').value
      });
      showToast(result.message);
      loadSalaryPayTab();
    } catch (err) { showToast(err.message, true); }
  });

  async function loadSalaryHistoryTab() {
    try {
      if (salaryTeachersCache.length === 0) {
        salaryTeachersCache = await apiCall('/salary/teachers');
      }
      const sel = document.getElementById('sal-hist-teacher');
      sel.innerHTML = '<option value="">-- Select Teacher --</option>' +
        salaryTeachersCache.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
      sel.onchange = async function() {
        if (!this.value) return;
        const payments = await apiCall('/salary/payments/' + this.value);
        const body = document.getElementById('sal-history-body');
        if (payments.length === 0) {
          body.innerHTML = '<tr><td colspan="10" class="sp-no-records-row">No payments found</td></tr>';
          return;
        }
        body.innerHTML = payments.map(p => `<tr>
          <td>${p.month}</td><td>${p.year}</td>
          <td>Rs. ${p.basic_salary||0}</td><td>Rs. ${p.allowances||0}</td>
          <td>Rs. ${p.deductions||0}</td><td>Rs. ${p.tax||0}</td>
          <td><strong style="color:var(--accent);">Rs. ${p.net_salary||0}</strong></td>
          <td>${p.payment_date||'-'}</td><td>${p.payment_method||'-'}</td><td>${p.paid_by||'-'}</td>
        </tr>`).join('');
      };
    } catch (err) { showToast('Error: ' + err.message, true); }
  }

  document.getElementById('sal-sum-load').addEventListener('click', async () => {
    const month = document.getElementById('sal-sum-month').value;
    const year = document.getElementById('sal-sum-year').value;
    try {
      const data = await apiCall(`/salary/summary?month=${encodeURIComponent(month)}&year=${year}`);
      const statsDiv = document.getElementById('sal-summary-stats');
      const total = data.totals?.total_paid || 0;
      const count = data.totals?.count || 0;
      statsDiv.innerHTML = `
        <div style="padding:12px 20px; background:rgba(0,200,150,0.1); border-radius:8px; border:1px solid rgba(0,200,150,0.3);">
          <div style="font-size:0.8rem; color:var(--text-muted);">Total Paid</div>
          <div style="font-size:1.3rem; font-weight:700; color:var(--accent);">Rs. ${total.toLocaleString()}</div>
        </div>
        <div style="padding:12px 20px; background:rgba(100,100,255,0.1); border-radius:8px; border:1px solid rgba(100,100,255,0.3);">
          <div style="font-size:0.8rem; color:var(--text-muted);">Teachers Paid</div>
          <div style="font-size:1.3rem; font-weight:700;">${count}</div>
        </div>`;
      const body = document.getElementById('sal-summary-body');
      if (data.payments.length === 0) {
        body.innerHTML = '<tr><td colspan="8" class="sp-no-records-row">No payments for this month</td></tr>';
        return;
      }
      body.innerHTML = data.payments.map(p => `<tr>
        <td><strong>${p.teacher_name}</strong></td><td>${p.subject||'-'}</td><td>${p.phone||'-'}</td>
        <td>Rs. ${p.basic_salary||0}</td><td>Rs. ${p.allowances||0}</td>
        <td>Rs. ${(p.deductions||0) + (p.tax||0)}</td>
        <td><strong style="color:var(--accent);">Rs. ${p.net_salary||0}</strong></td>
        <td>${p.payment_date||'-'}</td>
      </tr>`).join('');
    } catch (err) { showToast('Error: ' + err.message, true); }
  });


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

    const allLabel = `<label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:5px 10px; border-radius:6px; background:rgba(255,255,255,0.05);">
        <input type="checkbox" id="exam-class-all" value="All Classes"> <span>All Classes</span>
      </label>`;
    const otherLabel = `<label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:5px 10px; border-radius:6px; background:rgba(255,255,255,0.05); flex: 1 1 100%;">
        <span style="font-weight:600; min-width:50px;">Other:</span>
        <input type="text" id="exam-class-other" class="form-control" placeholder="e.g. Nursery, LKG, UKG (comma-separated)" style="flex:1; padding:4px 8px; font-size:0.85rem;">
      </label>`;

    let classes = [];
    try {
      invalidateClassCache();
      classes = await getCachedClasses(apiCall);
    } catch (e) { console.error('[EXAM_CLASSES]', e.message); }

    const classLabels = classes.map(cls => `
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; padding:5px 10px; border-radius:6px; background:rgba(255,255,255,0.05);">
          <input type="checkbox" class="exam-class-check" value="${cls}"> <span>${cls}</span>
        </label>
      `);

    container.innerHTML = allLabel + classLabels.join('') + otherLabel;
    document.getElementById('exam-class-all').addEventListener('change', (e) => {
      document.querySelectorAll('.exam-class-check').forEach(cb => cb.checked = e.target.checked);
    });
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

    } catch (e) { console.error('[EXAMS_DROPDOWN]', e.message); }
  }

  // Create exam registry
  document.getElementById('form-create-exam').addEventListener('submit', async (e) => {
    e.preventDefault();
    const exam_name = document.getElementById('exam-create-name').value;
    const year = document.getElementById('exam-create-year').value;

    // Get selected classes
    const allCb = document.getElementById('exam-class-all');
    const classCbs = document.querySelectorAll('.exam-class-check');
    const otherInput = document.getElementById('exam-class-other');
    let selectedClasses = [];
    if (allCb && allCb.checked) {
      selectedClasses = ['All Classes'];
    } else {
      classCbs.forEach(cb => { if (cb.checked) selectedClasses.push(cb.value); });
    }

    // Include manually typed "Other" classes
    if (otherInput && otherInput.value.trim()) {
      otherInput.value.split(',').forEach(c => {
        const trimmed = c.trim();
        if (trimmed && !selectedClasses.includes(trimmed)) selectedClasses.push(trimmed);
      });
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
      if (otherInput) otherInput.value = '';
    } catch (err) { console.error('[APP_ERROR]', err.message); }
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

      const rows = grid.map(s => {
        let rowHtml = '<tr data-student-id="' + s.id + '">';
        rowHtml += '<td style="position:sticky;left:0;background:var(--bg-primary);z-index:1;"><strong>' + (s.roll_no || '-') + '</strong></td>';
        rowHtml += '<td style="position:sticky;left:80px;background:var(--bg-primary);z-index:1;"><strong>' + s.name + '</strong></td>';
        rowHtml += '<td>' + s.class_name + ' - ' + (s.section_name || 'N/A') + '</td>';
        subjects.forEach(sub => {
          const val = s.marks[sub.subject] !== undefined ? s.marks[sub.subject] : '';
          rowHtml += '<td><input type="number" class="marks-input marks-cell" data-subject="' + sub.subject + '" data-max="' + sub.max_marks + '" value="' + val + '" min="0" max="' + sub.max_marks + '" placeholder="0"></td>';
        });
        rowHtml += '</tr>';
        return rowHtml;
      });
      tbody.innerHTML = rows.join('');

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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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

    const rows = list.map(s => `
        <tr class="clickable-row select-dmc-stud-row" data-id="${s.id}" style="cursor:pointer;">
          <td><strong>${s.roll_no || '-'}</strong></td>
          <td>${s.name}</td>
          <td>${s.class_name} - ${s.section_name || 'N/A'}</td>
        </tr>
      `);
    dmcStudentsTable.innerHTML = rows.join('');

    dmcStudentsTable.onclick = (e) => {
      const row = e.target.closest('.select-dmc-stud-row');
      if (!row) return;
      document.querySelectorAll('.select-dmc-stud-row').forEach(r => r.style.background = 'none');
      row.style.background = 'rgba(99, 102, 241, 0.15)';
      activeStudentDmcId = row.getAttribute('data-id');
      document.getElementById('dmc-fallback-msg').style.display = 'none';
    };
  }

  // Text search also works with class filter
  document.getElementById('dmc-student-search').addEventListener('input', debounce(loadDmcStudents, 300));

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
        const photoUrl = imgSrc(s.photo, '');

    let totalMax = 0, totalObt = 0;
    details.forEach(r => { totalMax += r.max_marks; totalObt += r.obtained_marks; });

    getCachedSettings(apiCall).then(set => {
      const schoolLogo = imgSrc(set.logo_path, 'school_assets/school_logo.png');
      const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const posLabel = sum.position && sum.position !== '-' ? sum.position : '-';
      const schoolDisplayName = set.school_name || currentUser.schoolName;

      const html = `
        <div style="font-family: Arial, Helvetica, sans-serif; color: #111; padding: 30px; background: white;">
          <div style="text-align: center; margin-bottom: 16px;">
            <img src="${schoolLogo}" style="width: 70px; height: 70px; border-radius: 50%; object-fit: cover; margin-bottom: 8px;" onerror="this.style.display='none'">
            <h1 style="margin: 0; font-size: 1.5rem; font-weight: 900; text-transform: uppercase; letter-spacing: 1px;">${schoolDisplayName}</h1>
            <h2 style="margin: 6px 0 0; font-size: 1.1rem; font-weight: 700; text-transform: uppercase;">DETAILED MARKS CERTIFICATE</h2>
            <p style="margin: 5px 0 0; font-size: 0.95rem; color: #333;">${term} Examination ${new Date().getFullYear()}</p>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; font-size: 0.95rem;">
            <div style="flex: 1;">
              <p style="margin: 4px 0;"><strong>Name:</strong> ${s.name} &nbsp;&nbsp;&nbsp; <strong>Father Name:</strong> ${s.father_name || '-'}</p>
              <p style="margin: 4px 0;"><strong>Roll No:</strong> ${s.roll_no || '-'} &nbsp;&nbsp;&nbsp; <strong>Class:</strong> ${s.class_name}${s.section_name ? ' - ' + s.section_name : ''}</p>
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
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 15%;">Total Marks</th>
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 15%;">Obtained Marks</th>
                <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 22%;">Remarks</th>
              </tr>
            </thead>
            <tbody>
              ${details.map((r, i) => `<tr>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${i + 1}</td>
                <td style="border: 1px solid #111; padding: 8px 10px;">${r.subject}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.max_marks}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.obtained_marks}</td>
                <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;"></td>
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
            <div style="flex: 1; padding: 12px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
              <span style="font-size: 0.85rem; font-weight: 700;">Percentage:</span>
              <span style="font-size: 1.1rem; font-weight: 900; color: #111;"> ${sum.percentage}%</span>
            </div>
            <div style="flex: 1; padding: 12px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
              <span style="font-size: 0.85rem; font-weight: 700;">Grade:</span>
              <span style="font-size: 1.1rem; font-weight: 900; color: #111;"> ${sum.grade}</span>
            </div>
            <div style="flex: 1; padding: 12px 10px; text-align: center; background: #f9f9f9;">
              <span style="font-size: 0.85rem; font-weight: 700;">Position:</span>
              <span style="font-size: 1.1rem; font-weight: 900; color: #111;"> ${posLabel}</span>
            </div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; font-size: 0.85rem; color: #333;">
            <div style="text-align: center;">
              <div style="margin-bottom: 35px; font-size: 0.85rem;">Signatures of:</div>
              <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Teacher incharge</div>
            </div>
            <div style="text-align: center;">
              <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Parent</div>
            </div>
            <div style="text-align: center;">
              <div style="margin-bottom: 8px; font-size: 0.85rem;">Principal Sign: _______________</div>
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

    getCachedSettings(apiCall).then(set => {
      const schoolLogo = imgSrc(set.logo_path, 'school_assets/school_logo.png');
      const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const schoolDisplayName = set.school_name || currentUser.schoolName;
      let html = '';

      allDmcs.forEach((dmc, idx) => {
        const s = dmc.student;
        const sum = dmc.summary;
        const details = dmc.reportDetails || [];
    const photoUrl = imgSrc(s.photo, '');
        let totalMax = 0, totalObt = 0;
        details.forEach(r => { totalMax += r.max_marks; totalObt += r.obtained_marks; });
        const posLabel = sum.position && sum.position !== '-' ? sum.position : '-';

        if (idx > 0) html += '<div style="page-break-after: always; break-after: page;"></div>';

        html += `
          <div style="font-family: Arial, Helvetica, sans-serif; color: #111; padding: 30px; background: white;">
            <div style="text-align: center; margin-bottom: 16px;">
              <img src="${schoolLogo}" style="width: 70px; height: 70px; border-radius: 50%; object-fit: cover; margin-bottom: 8px;" onerror="this.style.display='none'">
              <h1 style="margin: 0; font-size: 1.5rem; font-weight: 900; text-transform: uppercase; letter-spacing: 1px;">${schoolDisplayName}</h1>
              <h2 style="margin: 6px 0 0; font-size: 1.1rem; font-weight: 700; text-transform: uppercase;">DETAILED MARKS CERTIFICATE</h2>
              <p style="margin: 5px 0 0; font-size: 0.95rem; color: #333;">${term} Examination ${new Date().getFullYear()}</p>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; font-size: 0.95rem;">
              <div style="flex: 1;">
                <p style="margin: 4px 0;"><strong>Name:</strong> ${s.name} &nbsp;&nbsp;&nbsp; <strong>Father Name:</strong> ${s.father_name || '-'}</p>
                <p style="margin: 4px 0;"><strong>Roll No:</strong> ${s.roll_no || '-'} &nbsp;&nbsp;&nbsp; <strong>Class:</strong> ${s.class_name}${s.section_name ? ' - ' + s.section_name : ''}</p>
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
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 15%;">Total Marks</th>
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 15%;">Obtained Marks</th>
                  <th style="border: 1px solid #111; padding: 8px 10px; text-align: center; width: 22%;">Remarks</th>
                </tr>
              </thead>
              <tbody>
                ${details.map((r, i) => `<tr>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${i + 1}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px;">${r.subject}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.max_marks}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;">${r.obtained_marks}</td>
                  <td style="border: 1px solid #111; padding: 8px 10px; text-align: center;"></td>
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
              <div style="flex: 1; padding: 12px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
                <span style="font-size: 0.85rem; font-weight: 700;">Percentage:</span>
                <span style="font-size: 1.1rem; font-weight: 900; color: #111;"> ${sum.percentage}%</span>
              </div>
              <div style="flex: 1; padding: 12px 10px; text-align: center; border-right: 2px solid #111; background: #f9f9f9;">
                <span style="font-size: 0.85rem; font-weight: 700;">Grade:</span>
                <span style="font-size: 1.1rem; font-weight: 900; color: #111;"> ${sum.grade}</span>
              </div>
              <div style="flex: 1; padding: 12px 10px; text-align: center; background: #f9f9f9;">
                <span style="font-size: 0.85rem; font-weight: 700;">Position:</span>
                <span style="font-size: 1.1rem; font-weight: 900; color: #111;"> ${posLabel}</span>
              </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 20px; font-size: 0.85rem; color: #333;">
              <div style="text-align: center;">
                <div style="margin-bottom: 35px; font-size: 0.85rem;">Signatures of:</div>
                <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Teacher incharge</div>
              </div>
              <div style="text-align: center;">
                <div style="border-top: 1px solid #111; width: 150px; padding-top: 5px;">Parent</div>
              </div>
              <div style="text-align: center;">
                <div style="margin-bottom: 8px; font-size: 0.85rem;">Principal Sign: _______________</div>
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

    const printWindow = window.open('', '_blank');
    printWindow.document.write(`<html><head><title>Print DMC</title><style>@page{margin:0;size:A4;}@media print{body{margin:0;padding:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;}}</style></head><body style="padding:40px;background:white;color:black;font-family:sans-serif;min-height:100vh;">${sheetContent}</body></html>`);
    printWindow.document.close();
    printWindow.focus();
    printWindow.print();
    printWindow.close();
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
    // Reset edit mode
    document.getElementById('datesheet-edit-id').value = '';
    document.getElementById('datesheet-template-name').value = '';
    const saveBtn = document.getElementById('btn-save-datesheet');
    if (saveBtn) saveBtn.textContent = 'Save Date Sheet Template';
    // Load saved templates into both generate tab dropdown AND designer dropdown
    loadDatesheetTemplates();
    loadDatesheetDesignerDropdown();
  }

  // Populate the designer "Load Existing Template" dropdown
  async function loadDatesheetDesignerDropdown() {
    const sel = document.getElementById('datesheet-design-template');
    if (!sel) return;
    try {
      const templates = await apiCall('/exams/datesheets');
      const uniqueMap = {};
      templates.forEach(t => {
        const key = t.name;
        if (!uniqueMap[key] || t.id > uniqueMap[key].id) {
          uniqueMap[key] = t;
        }
      });
      const unique = Object.values(uniqueMap).sort((a, b) => b.id - a.id);
      sel.innerHTML = '<option value="">-- Create New Template --</option>';
      unique.forEach(t => {
        const activeMark = t.is_active ? ' [ACTIVE]' : '';
        const style = t.is_active ? ' style="font-weight:bold;color:#16a34a;"' : '';
        sel.innerHTML += '<option value="' + t.id + '"' + style + '>' + t.name + activeMark + '</option>';
      });
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // Load selected template into the designer form for editing
  document.getElementById('btn-load-datesheet-to-design').addEventListener('click', async () => {
    const sel = document.getElementById('datesheet-design-template');
    const templateId = sel.value;
    if (!templateId) {
      // Reset to new template mode
      document.getElementById('datesheet-edit-id').value = '';
      document.getElementById('datesheet-template-name').value = '';
      document.getElementById('datesheet-term-select').selectedIndex = 0;
      document.getElementById('datesheet-rows-container').innerHTML = '';
      datesheetRowCount = 0;
      const saveBtn = document.getElementById('btn-save-datesheet');
      if (saveBtn) saveBtn.textContent = 'Save Date Sheet Template';
      return;
    }
    try {
      const templates = await apiCall('/exams/datesheets');
      const tpl = templates.find(t => t.id == templateId);
      if (!tpl) { showToast('Template not found', true); return; }
      const t = tpl.template;

      // Set edit mode
      document.getElementById('datesheet-edit-id').value = tpl.id;
      document.getElementById('datesheet-template-name').value = tpl.name;

      // Set exam dropdown
      const examSel = document.getElementById('datesheet-exam-select');
      if (t.exam_id) {
        for (let i = 0; i < examSel.options.length; i++) {
          if (examSel.options[i].value == t.exam_id) { examSel.selectedIndex = i; break; }
        }
      }

      // Set term
      const termSel = document.getElementById('datesheet-term-select');
      if (t.term) {
        for (let i = 0; i < termSel.options.length; i++) {
          if (termSel.options[i].value === t.term) { termSel.selectedIndex = i; break; }
        }
      }

      // Clear and rebuild rows
      const container = document.getElementById('datesheet-rows-container');
      container.innerHTML = '';
      datesheetRowCount = 0;

      let dsClasses = [];
      try { dsClasses = await getCachedClasses(apiCall); } catch (e) {}

      const subjects = t.subjects || [];
      subjects.forEach(sub => {
        datesheetRowCount++;
        let classOpts = '<option value="All Classes">All Classes</option>';
        if (dsClasses && dsClasses.length > 0) {
          dsClasses.forEach(cls => { classOpts += `<option value="${cls}">${cls}</option>`; });
        }
        const rowHtml = `
          <div style="display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr auto; gap: 10px; margin-bottom: 10px; align-items: flex-end;" id="datesheet-row-${datesheetRowCount}">
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label">Subject</label>
              <input type="text" class="form-control" placeholder="e.g. Mathematics" required value="${sub.subject || ''}">
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label">Class</label>
              <select class="form-control ds-row-class" required>${classOpts}</select>
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label">Date</label>
              <input type="date" class="form-control" required value="${sub.date || ''}">
            </div>
            <div class="form-group" style="margin-bottom: 0;">
              <label class="form-label">Time</label>
              <input type="text" class="form-control" placeholder="e.g. 9:00 AM - 12:00 PM" required value="${sub.time || ''}">
            </div>
            <button type="button" class="btn btn-danger btn-sm btn-remove-datesheet-row" style="margin-bottom: 2px;">&times;</button>
          </div>
        `;
        container.insertAdjacentHTML('beforeend', rowHtml);
        // Set class select value
        const newRow = document.getElementById('datesheet-row-' + datesheetRowCount);
        const classSelect = newRow.querySelector('.ds-row-class');
        if (sub.class) {
          for (let i = 0; i < classSelect.options.length; i++) {
            if (classSelect.options[i].value === sub.class) { classSelect.selectedIndex = i; break; }
          }
        }
      });

      const saveBtn = document.getElementById('btn-save-datesheet');
      if (saveBtn) saveBtn.textContent = 'Update Date Sheet Template';
      showToast('Template loaded — ' + subjects.length + ' subjects');
    } catch (err) { showToast('Failed to load template', true); }
  });

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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
    btnAddDatesheetRow.addEventListener('click', async () => {
      datesheetRowCount++;
      const container = document.getElementById('datesheet-rows-container');
      // Build class options from cached classes
      let classOpts = '<option value="All Classes">All Classes</option>';
      try {
        const classes = await getCachedClasses(apiCall);
        if (classes && classes.length > 0) {
          classes.forEach(cls => { classOpts += `<option value="${cls}">${cls}</option>`; });
        }
      } catch (e) { console.error('[DSROW]', e.message); }
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
      const editId = document.getElementById('datesheet-edit-id').value;

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
        let res;
        if (editId) {
          res = await apiCall('/exams/datesheets/' + editId, 'PUT', { name, template_json: JSON.stringify(template) });
        } else {
          res = await apiCall('/exams/datesheets', 'POST', { name, template_json: JSON.stringify(template) });
        }
        showToast(res.message);
        formDatesheetDesign.reset();
        document.getElementById('datesheet-rows-container').innerHTML = '';
        document.getElementById('datesheet-edit-id').value = '';
        datesheetRowCount = 0;
        const saveBtn = document.getElementById('btn-save-datesheet');
        if (saveBtn) saveBtn.textContent = 'Save Date Sheet Template';
        loadDatesheetTemplates();
        loadDatesheetDesignerDropdown();
      } catch (err) { console.error('[APP_ERROR]', err.message); }
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
        const [exams, settings] = await Promise.all([
          apiCall('/exams'),
          apiCall('/settings').catch(() => ({}))
        ]);
        const exam = exams.find(ex => ex.id == t.exam_id);
        const logoUrl = imgSrc(settings.logo_path, 'school_assets/school_logo.png');

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
      } catch (err) { console.error('[APP_ERROR]', err.message); }
    });
  }

  const btnPrintDatesheet = document.getElementById('btn-print-datesheet');
  if (btnPrintDatesheet) {
    btnPrintDatesheet.addEventListener('click', () => {
      const content = document.getElementById('datesheet-printable-content').innerHTML;
      const printWindow = window.open('', '_blank');
      printWindow.document.write(`<html><head><title>Print Datesheet</title><style>@page{margin:0;size:A4;}</style></head><body style="padding:40px;background:white;color:black;font-family:sans-serif;min-height:100vh;">${content}</body></html>`);
      printWindow.document.close();
      printWindow.focus();
      printWindow.print();
      printWindow.close();
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
        loadDatesheetDesignerDropdown();
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
        loadDatesheetDesignerDropdown();
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
      } catch (err) { console.error('[APP_ERROR]', err.message); }
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

        let settings = {}, activeDatesheet = null, principal_sign = null, templateInstructions = null, templateTerm = '';
        const [examsRaw, settingsRaw, activeDatesheetRaw, rollnoTemplatesRaw] = await Promise.all([
          apiCall('/exams'),
          apiCall('/settings').catch(() => ({})),
          apiCall('/exams/datesheets/active').catch(() => null),
          apiCall('/exams/rollno-templates').catch(() => [])
        ]);

        const exam = examsRaw.find(e => e.id == exam_id);
        settings = settingsRaw;
        activeDatesheet = activeDatesheetRaw;
        if (rollnoTemplatesRaw.length > 0) {
          const tmpl = rollnoTemplatesRaw[0].template;
          principal_sign = tmpl.principal_sign || null;
          templateInstructions = tmpl.instructions || null;
          templateTerm = tmpl.term || '';
        }
        const logoUrl = imgSrc(settings.logo_path, 'school_assets/school_logo.png');

        if (students.length === 0) {
          showToast('No students found', true);
          return;
        }

        let slipsHtml = '';
        let slipCount = 0;
        // v2 - exact match to reference layout
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
                '<td style="border:1.5px solid #000; padding:5px 5px; text-align:center; word-wrap:break-word; overflow-wrap:break-word;">' + (i + 1) + '</td>' +
                '<td style="border:1.5px solid #000; padding:5px 5px; text-align:center; word-wrap:break-word; overflow-wrap:break-word;">' + dateFormatted + '</td>' +
                '<td style="border:1.5px solid #000; padding:5px 5px; text-align:center; word-wrap:break-word; overflow-wrap:break-word;">' + dayName + '</td>' +
                '<td style="border:1.5px solid #000; padding:5px 5px; text-align:left; word-wrap:break-word; overflow-wrap:break-word;">' + sub.subject + '</td>' +
                '<td style="border:1.5px solid #000; padding:5px 5px; text-align:center; word-wrap:break-word; overflow-wrap:break-word;">' + (sub.time || '-') + '</td>' +
                '</tr>';
            });
          } else {
            tableRows = '<tr><td colspan="5" style="border:1.5px solid #000; padding:10px; text-align:center; color:#888;">No datesheet available</td></tr>';
          }

          const instructions = templateInstructions
            ? templateInstructions.split('. ').filter(Boolean).map(i => i.endsWith('.') ? i : i + '.')
            : [
                'All Students Must be Uniformed.',
                'Students Must come on time.',
                'Dues Must be cleared.'
              ];
          let instHtml = instructions.map(inst => '<li>' + inst.replace(/\.$/, '') + '</li>').join('');

          const studentPhoto = imgSrc(s.photo, '');

          // Open a new page div every 2 slips
          if (slipCount % 2 === 0) {
            slipsHtml += '<div class="rollno-page">';
          }

          const examName = templateTerm
            ? templateTerm + ' ' + (exam ? exam.exam_name + ' ' + exam.year : '')
            : (exam ? exam.exam_name + ' Exam ' + exam.year : '');

          slipsHtml +=
            '<div class="rollno-slip" style="width:100%; display:flex; flex-direction:column; padding:4% 10px; font-family:Arial,sans-serif; box-sizing:border-box; overflow:hidden;">' +

              // === HEADER: School name ===
              '<div style="text-align:center;">' +
                '<div style="font-size:17px; font-weight:900; color:#000; text-transform:uppercase; letter-spacing:1.5px; line-height:1.2;">' + currentUser.schoolName + '</div>' +
              '</div>' +

              // === Logo + ROLL NO SLIP title ===
              '<div style="display:flex; align-items:center; gap:12px; margin-top:4px;">' +
                '<img src="' + logoUrl + '" alt="Logo" style="width:55px; height:55px; border-radius:50%; flex-shrink:0; border:2px solid #ddd;" onerror="this.style.display=\'none\'">' +
                '<div style="text-align:center; flex:1;">' +
                  '<div style="font-size:15px; font-weight:900; letter-spacing:2px; color:#000;">ROLL NO SLIP</div>' +
                  '<div style="font-size:11px; color:#333; margin-top:2px; font-weight:600;">' + examName + '</div>' +
                '</div>' +
              '</div>' +

              // === Student info ===
              '<div style="display:grid; grid-template-columns:1fr 1fr; gap:3px 20px; font-size:13px; padding:6px 0; font-weight:600;">' +
                '<div><strong>Name:</strong>&nbsp;&nbsp;' + (s.name || '-') + '</div>' +
                '<div><strong>Class:</strong>&nbsp;&nbsp;' + (s.class_name || '-') + (s.section_name ? ' - ' + s.section_name : '') + '</div>' +
                '<div><strong>Father Name:</strong>&nbsp;&nbsp;' + (s.father_name || '-') + '</div>' +
                '<div><strong>Roll No:</strong>&nbsp;&nbsp;' + (s.roll_no || '-') + '</div>' +
              '</div>' +

              // === Exam table ===
              '<div class="rollno-exam-table-wrap">' +
                '<table style="width:100%; border-collapse:collapse; font-size:11px; table-layout:fixed;">' +
                  '<colgroup>' +
                    '<col style="width:6%;">' +
                    '<col style="width:22%;">' +
                    '<col style="width:20%;">' +
                    '<col style="width:30%;">' +
                    '<col style="width:22%;">' +
                  '</colgroup>' +
                  '<thead>' +
                    '<tr>' +
                      '<th style="border:1.5px solid #000; padding:5px 5px; text-align:center; font-weight:700; background:#f0f0f0;">#</th>' +
                      '<th style="border:1.5px solid #000; padding:5px 5px; text-align:center; font-weight:700; background:#f0f0f0;">Date</th>' +
                      '<th style="border:1.5px solid #000; padding:5px 5px; text-align:center; font-weight:700; background:#f0f0f0;">Day</th>' +
                      '<th style="border:1.5px solid #000; padding:5px 5px; text-align:left; font-weight:700; background:#f0f0f0;">Subject</th>' +
                      '<th style="border:1.5px solid #000; padding:5px 5px; text-align:center; font-weight:700; background:#f0f0f0;">Time</th>' +
                    '</tr>' +
                  '</thead>' +
                  '<tbody>' + tableRows + '</tbody>' +
                '</table>' +
              '</div>' +

              // === Footer: Instructions + Signature (pinned to bottom) ===
              '<div class="rollno-footer" style="display:flex; justify-content:space-between; align-items:flex-end; font-size:12px; margin-top:auto; padding-top:8px;">' +
                '<div style="max-width:55%;">' +
                  '<div style="font-weight:700; margin-bottom:2px; font-size:12px;">Instructions:</div>' +
                  '<ul style="margin:0; padding-left:14px; list-style:disc; line-height:1.5;">' + instHtml + '</ul>' +
                '</div>' +
                '<div style="text-align:center;">' +
                  (principal_sign ?
                    '<img src="' + principal_sign + '" alt="Sign" style="max-height:35px; max-width:80px; opacity:0.85;" onerror="this.style.display=\'none\'">' :
                    '<div style="height:35px;"></div>'
                  ) +
                  '<div style="border-top:1px solid #000; width:120px; margin:0 auto; padding-top:4px; font-size:11px; font-weight:600;">Principal Signature</div>' +
                '</div>' +
              '</div>' +

            '</div>';

          slipCount++;

          // Close page div after every 2 slips, or at the end
          if (slipCount % 2 === 0 || idx === students.length - 1) {
            slipsHtml += '</div>';
          }
        });

        document.getElementById('rollno-printable-content').innerHTML = slipsHtml;
        document.getElementById('rollno-preview').style.display = 'block';
      } catch (err) { console.error('[APP_ERROR]', err.message); }
    });
  }

  const btnPrintRollno = document.getElementById('btn-print-rollno');
  if (btnPrintRollno) {
    btnPrintRollno.addEventListener('click', () => {
      const content = document.getElementById('rollno-printable-content').innerHTML;
      const printHtml = '<!DOCTYPE html><html><head>' +
        '<meta charset="utf-8">' +
        '<title>Roll No Slips</title>' +
        '<style>' +
          /* ========== A4 LANDSCAPE PAGE SETUP ========== */
          '@page { size: A4 landscape; margin: 8mm; }' +
          'html, body {' +
            'margin:0 !important;' +
            'padding:0 !important;' +
            'height:100% !important;' +
            'background:white !important;' +
            'font-family:Arial, sans-serif;' +
            '-webkit-print-color-adjust:exact !important;' +
            'print-color-adjust:exact !important;' +
          '}' +
          /* ========== ROLLNO-PAGE: 2 slips per page, fills full page height ========== */
          '.rollno-page {' +
            'display:grid !important;' +
            'grid-template-columns:repeat(2, 1fr) !important;' +
            'grid-template-rows:1fr !important;' +
            'gap:4mm !important;' +
            'width:100% !important;' +
            'height:100% !important;' +
            'padding:0 !important;' +
            'margin:0 !important;' +
            'page-break-after:always !important;' +
            'overflow:hidden !important;' +
            'box-sizing:border-box !important;' +
          '}' +
          '.rollno-page:last-child { page-break-after:auto !important; }' +
          /* ========== ROLLNO-SLIP: fills page height ========== */
          '.rollno-slip {' +
            'width:100% !important;' +
            'height:100% !important;' +
            'max-width:none !important;' +
            'min-width:0 !important;' +
            'box-sizing:border-box !important;' +
            'break-inside:avoid !important;' +
            'page-break-inside:avoid !important;' +
            'border:none !important;' +
            'border-radius:0 !important;' +
            'overflow:hidden !important;' +
            'display:flex !important;' +
            'flex-direction:column !important;' +
            'align-self:stretch !important;' +
          '}' +
          /* ========== EXAM TABLE SECTION ========== */
          '.rollno-slip .rollno-exam-table-wrap {' +
            'width:100% !important;' +
          '}' +
          /* ========== TABLE: fixed layout ========== */
          '.rollno-slip table {' +
            'width:100% !important;' +
            'table-layout:fixed !important;' +
            'border-collapse:collapse !important;' +
          '}' +
          '.rollno-slip table th,' +
          '.rollno-slip table td {' +
            'word-wrap:break-word !important;' +
            'overflow-wrap:break-word !important;' +
            'padding:5px 5px !important;' +
            'font-size:10px !important;' +
          '}' +
          /* ========== COLUMN WIDTHS ========== */
          '.rollno-slip table th:nth-child(1),.rollno-slip table td:nth-child(1){width:6%!important;}' +
          '.rollno-slip table th:nth-child(2),.rollno-slip table td:nth-child(2){width:22%!important;}' +
          '.rollno-slip table th:nth-child(3),.rollno-slip table td:nth-child(3){width:20%!important;}' +
          '.rollno-slip table th:nth-child(4),.rollno-slip table td:nth-child(4){width:30%!important;}' +
          '.rollno-slip table th:nth-child(5),.rollno-slip table td:nth-child(5){width:22%!important;}' +
          /* ========== FOOTER: pinned to bottom ========== */
          '.rollno-slip .rollno-footer {' +
            'width:100% !important;' +
            'margin-top:auto !important;' +
          '}' +
          /* ========== PRINT MEDIA: force landscape, override all responsive ========== */
          '@media print {' +
            '@page { size: A4 landscape !important; margin: 8mm !important; }' +
            'html,body{margin:0!important;padding:0!important;height:100%!important;background:white!important;}' +
            '.rollno-page{display:grid!important;grid-template-columns:repeat(2,1fr)!important;grid-template-rows:1fr!important;gap:4mm!important;width:100%!important;height:100%!important;padding:0!important;margin:0!important;page-break-after:always!important;}' +
            '.rollno-page:last-child{page-break-after:auto!important;}' +
            '.rollno-slip{width:100%!important;height:100%!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important;break-inside:avoid!important;page-break-inside:avoid!important;border:none!important;border-radius:0!important;display:flex!important;flex-direction:column!important;align-self:stretch!important;}' +
            '.rollno-slip .rollno-exam-table-wrap{width:100%!important;}' +
            '.rollno-slip table{width:100%!important;table-layout:fixed!important;border-collapse:collapse!important;}' +
            '.rollno-slip table th,.rollno-slip table td{word-wrap:break-word!important;overflow-wrap:break-word!important;padding:5px 5px!important;font-size:10px!important;}' +
            '.rollno-slip .rollno-footer{width:100%!important;margin-top:auto!important;}' +
          '}' +
        '</style>' +
        '</head><body>' +
        content +
        '</body></html>';

      const printWindow = window.open('', '_blank');
      if (printWindow) {
        printWindow.document.write(printHtml);
        printWindow.document.close();
        setTimeout(() => { printWindow.print(); }, 600);
      } else {
        const pw = window.open('', '_blank');
        pw.document.write(printHtml);
        pw.document.close();
        pw.focus();
        pw.print();
        pw.close();
      }
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
    } catch (err) { console.error('[APP_ERROR]', err.message); }
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
    } catch (err) { console.error('[APP_ERROR]', err.message); }
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
    } catch (err) { console.error('[APP_ERROR]', err.message); }
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
  // MODULE: BILLING & SUBSCRIPTION
  // ==========================================
  async function loadBillingData() {
    try {
      const data = await apiCall('/billing/status');
      
      const monthlyRate = data.school.subscription_amount || 1500;

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

      // Update dynamic monthly rate display
      const monthlyRateEl = document.getElementById('sub-monthly-rate');
      if (monthlyRateEl) monthlyRateEl.innerText = `${monthlyRate.toLocaleString()} PKR`;

      const transferMsgEl = document.getElementById('sub-transfer-msg');
      if (transferMsgEl) transferMsgEl.innerText = `Transfer ${monthlyRate.toLocaleString()} PKR to any of the verified payment accounts, then upload a screenshot of your transaction confirmation.`;

      const billAmountEl = document.getElementById('bill-amount');
      if (billAmountEl) billAmountEl.value = monthlyRate;

      // Dynamically render verified payment accounts from API
      if (data.paymentInstructions && data.paymentInstructions.methods) {
        const methods = data.paymentInstructions.methods;
        const colors = ['var(--primary-light)', 'var(--secondary-light)', 'var(--success-light)'];
        const borders = ['var(--primary)', 'var(--secondary)', 'var(--success)'];
        const container = document.querySelector('#screen-subscription .grid-2 .card:last-child .card > div:last-child') || document.querySelector('#screen-subscription .grid-2 > div:last-child > div:last-child');

        // Find the container for verified payment accounts
        const allCards = document.querySelectorAll('#screen-subscription .grid-2 > div');
        let accountsContainer = null;
        allCards.forEach(card => {
          const h3 = card.querySelector('h3');
          if (h3 && h3.textContent.includes('Verified Payment Accounts')) {
            accountsContainer = card.querySelector('div:last-child');
          }
        });

        if (accountsContainer) {
          accountsContainer.innerHTML = methods.map((m, i) => `
            <div style="padding: 15px; background: ${colors[i] || colors[0]}; border-radius: 10px; border-left: 4px solid ${borders[i] || borders[0]};">
              <h4>${m.name}</h4>
              <p style="color: var(--text-muted); font-size: 0.9rem; margin-top: 4px;">${m.name.includes('Bank') ? 'Account' : 'Number'}: <strong>${m.account_no}</strong></p>
              <p style="color: var(--text-muted); font-size: 0.9rem;">Title: <strong>${m.title}</strong></p>
            </div>
          `).join('');
        }
      }

      // Render payment history
      const tbody = document.querySelector('#table-billing-slips tbody');
      tbody.innerHTML = '';

      if (data.paymentHistory.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color:var(--text-muted);">No payment receipts uploaded.</td></tr>';
        return;
      }

      const rows = data.paymentHistory.map(slip => {
        let statusBadge = 'status-partial';
        if (slip.status === 'approved') statusBadge = 'status-present';
        else if (slip.status === 'rejected') statusBadge = 'status-absent';

        return `
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
      tbody.innerHTML = rows.join('');

    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
      if (opt === 'manage-teachers') { loadTeachersList(); loadTeacherClassDropdown(); }
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
  async function loadTeacherClassDropdown() {
    try {
      const classes = await apiCall('/students/classes');
      const sel = document.getElementById('teacher-assigned-class');
      if (!sel) return;
      sel.innerHTML = '<option value="">-- No Class Assigned --</option>';
      classes.forEach(c => {
        const name = typeof c === 'object' ? c.class_name : c;
        sel.innerHTML += `<option value="${name}">${name}</option>`;
      });
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

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
        const assignedClass = t.assigned_class || '<span style="color:var(--text-muted);">None</span>';
        const feeAccess = t.can_collect_fees ? '<span class="badge badge-green">Yes</span>' : '<span class="badge badge-red">No</span>';
        return `
        <tr>
          <td><strong>${t.name}</strong></td>
          <td>${t.phone}</td>
          <td>${assignedClass}</td>
          <td>${feeAccess}</td>
          <td><span class="badge ${t.status === 'Active' ? 'badge-green' : 'badge-red'}">${t.status}</span></td>
          <td>
            <button class="btn btn-outline btn-sm btn-edit-teacher" data-id="${t.id}" data-name="${t.name}" data-phone="${t.phone}" data-qualification="${t.qualification || ''}" data-status="${t.status}" data-assigned-class="${t.assigned_class || ''}" data-can-collect-fees="${t.can_collect_fees || 0}">Edit</button>
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
          document.getElementById('teacher-assigned-class').value = btn.dataset.assignedClass;
          document.getElementById('teacher-can-collect-fees').checked = btn.dataset.canCollectFees === '1';
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  document.getElementById('form-teacher').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('teacher-edit-id').value;
    const name = document.getElementById('teacher-name').value.trim();
    const phone = document.getElementById('teacher-phone').value.trim();
    const password = document.getElementById('teacher-password').value;
    const qualification = document.getElementById('teacher-qualification').value.trim();
    const assigned_class = document.getElementById('teacher-assigned-class').value;
    const can_collect_fees = document.getElementById('teacher-can-collect-fees').checked;

    if (!name || !phone) return;
    if (!editId && !password) { showToast('Password is required for new teacher', true); return; }

    try {
      if (editId) {
        const body = { name, phone, qualification, assigned_class, can_collect_fees };
        if (password) body.password = password;
        await apiCall(`/staff/teachers/${editId}`, 'PUT', body);
        showToast('Teacher updated');
      } else {
        await apiCall('/staff/teachers', 'POST', { name, phone, password, qualification, assigned_class, can_collect_fees });
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
      // Load classes for parent class selector
      const classes = await apiCall('/students/classes');
      const parentClassSelect = document.getElementById('parent-class-select');
      if (parentClassSelect) {
        parentClassSelect.innerHTML = '<option value="">-- Select Class --</option>';
        classes.forEach(cls => {
          parentClassSelect.innerHTML += `<option value="${cls}">${cls}</option>`;
        });
      }

      // Load existing parents list
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  // Parent class selector -> load students for that class
  document.getElementById('parent-class-select').addEventListener('change', async function() {
    const className = this.value;
    const studentSelect = document.getElementById('parent-student-select');
    const passwordField = document.getElementById('parent-password');
    const submitBtn = document.getElementById('btn-parent-submit');
    const studentInfo = document.getElementById('parent-student-info');

    studentSelect.innerHTML = '<option value="">-- Select Student --</option>';
    studentSelect.disabled = true;
    passwordField.disabled = true;
    submitBtn.disabled = true;
    studentInfo.style.display = 'none';
    document.getElementById('parent-student-id').value = '';

    if (!className) return;

    try {
      const students = await apiCall(`/students?class_name=${encodeURIComponent(className)}`);
      if (students.length === 0) {
        studentSelect.innerHTML = '<option value="">-- No students in this class --</option>';
        return;
      }
      students.forEach(s => {
        studentSelect.innerHTML += `<option value="${s.id}" data-phone="${s.phone || ''}" data-name="${s.name}" data-father="${s.father_name || '-'}">${s.name} (${s.roll_no || '-'})</option>`;
      });
      studentSelect.disabled = false;
    } catch (e) {
      showToast('Failed to load students', true);
    }
  });

  // Parent student selector -> show student info and enable password
  document.getElementById('parent-student-select').addEventListener('change', function() {
    const option = this.options[this.selectedIndex];
    const passwordField = document.getElementById('parent-password');
    const submitBtn = document.getElementById('btn-parent-submit');
    const studentInfo = document.getElementById('parent-student-info');

    if (!this.value) {
      passwordField.disabled = true;
      submitBtn.disabled = true;
      studentInfo.style.display = 'none';
      document.getElementById('parent-student-id').value = '';
      return;
    }

    document.getElementById('parent-student-id').value = this.value;
    document.getElementById('parent-student-name').textContent = option.dataset.name || '-';
    document.getElementById('parent-student-phone').textContent = option.dataset.phone || '-';
    document.getElementById('parent-student-father').textContent = option.dataset.father || '-';
    studentInfo.style.display = 'block';
    passwordField.disabled = false;
    submitBtn.disabled = false;
  });

  document.getElementById('form-parent').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('parent-edit-id').value;
    const studentId = document.getElementById('parent-student-id').value;
    const password = document.getElementById('parent-password').value;
    const studentSelect = document.getElementById('parent-student-select');
    const selectedOption = studentSelect.options[studentSelect.selectedIndex];
    const phone = selectedOption ? selectedOption.dataset.phone : '';

    if (!studentId || !phone) {
      showToast('Please select a student first', true);
      return;
    }
    if (!editId && !password) { showToast('Password is required for new parent', true); return; }

    try {
      if (editId) {
        const body = { name: '', phone, status: 'Active' };
        if (password) body.password = password;
        await apiCall(`/staff/parents/${editId}`, 'PUT', body);
        showToast('Parent account updated');
      } else {
        await apiCall('/staff/parents/create-with-student', 'POST', { student_id: studentId, phone, password });
        showToast('Parent account created & linked to student');
      }
      resetParentForm();
      loadParentsList();
    } catch (err) { showToast(err.message, true); }
  });

  function resetParentForm() {
    document.getElementById('form-parent').reset();
    document.getElementById('parent-edit-id').value = '';
    document.getElementById('parent-student-id').value = '';
    document.getElementById('parent-class-select').value = '';
    document.getElementById('parent-student-select').innerHTML = '<option value="">-- Select Student --</option>';
    document.getElementById('parent-student-select').disabled = true;
    document.getElementById('parent-password').disabled = true;
    document.getElementById('btn-parent-submit').disabled = true;
    document.getElementById('parent-student-info').style.display = 'none';
    document.getElementById('parent-form-title').textContent = 'Create Parent Account';
    document.getElementById('btn-parent-submit').textContent = 'Create Account';
    document.getElementById('btn-parent-cancel').style.display = 'none';
  }

  document.getElementById('btn-parent-cancel').addEventListener('click', resetParentForm);

  // ==========================================
  // TIMETABLE
  // ==========================================
  async function populateTimetableDropdowns() {
    try {
      const [classes, teachers] = await Promise.all([
        apiCall('/students/classes'),
        apiCall('/staff/teachers')
      ]);
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
    } catch (e) { console.error('[APP_ERROR]', e.message); }
  }

  document.getElementById('tt-class').addEventListener('change', async () => {
    const class_name = document.getElementById('tt-class').value;
    const ttSection = document.getElementById('tt-section');
    ttSection.innerHTML = '<option value="">-- All Sections --</option>';
    if (!class_name) return;
    try {
      const sections = await apiCall(`/students/sections/${encodeURIComponent(class_name)}`);
      sections.forEach(s => { ttSection.innerHTML += `<option value="${s.section_name}">${s.section_name}</option>`; });
    } catch (e) { console.error('[APP_ERROR]', e.message); }
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
          await window._loadTesseract();
          statusEl.textContent = '⏳ Recognizing text... This may take a moment.';

        // Read image as data URL first
        const imageDataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result);
          reader.onerror = () => reject(new Error('Failed to read file'));
          reader.readAsDataURL(fileInput.files[0]);
        });

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

      getCachedSettings(apiCall).then(set => {
        const logoUrl = imgSrc(set.logo_path, 'school_assets/school_logo.png');
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

  // Initialize Offline-First Engine
  (async function initOfflineEngine() {
    try {
      await window.SkyHonixOffline.init({
        token: token,
        apiBase: ''
      });
      window.SkyHonixOffline.setOnlineApiCall(async (endpoint, method, body, isFormData) => {
        const headers = { 'Authorization': `Bearer ${token}` };
        if (!isFormData) headers['Content-Type'] = 'application/json';
        const options = { method, headers };
        if (body) options.body = isFormData ? body : JSON.stringify(body);
        const response = await fetch(`/api${endpoint}`, options);
        const text = await response.text();
        let result;
        try { result = JSON.parse(text); } catch (e) { throw new Error('Invalid server response'); }
        if (!response.ok) throw new Error(result.error || 'Request failed');
        if (response.status === 401 || response.status === 403) {
          if (result.suspended || result.pending) {
            lockOverlay.style.display = 'flex';
          } else {
            localStorage.removeItem('skyhonix_token');
            localStorage.removeItem('skyhonix_user');
            window.location.href = 'index.html';
          }
        }
        if (result.syncEvent) await handleSyncEvent(result.syncEvent, result);
        return result;
      });
    } catch (e) {
      console.warn('[Offline] Engine init failed:', e);
    }
  })();

  checkBillingStatus();
  loadDashboardStats();
  loadDashboardExamDropdown();

});
