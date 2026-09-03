(() => {
  function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

  const token = localStorage.getItem('skyhonix_token');
  const userJson = localStorage.getItem('skyhonix_user');
  if (!token || !userJson) {
    window.location.href = 'index.html';
    return;
  }
  const currentUser = JSON.parse(userJson);
  if (currentUser.role !== 'parent') {
    window.location.href = currentUser.role === 'teacher' ? 'teacher-portal.html' : 'portal.html';
    return;
  }

  const headerUserBadge = document.getElementById('header-user-badge');
  const headerTitle = document.getElementById('header-title');
  const childSelector = document.getElementById('child-selector');
  const childSelect = document.getElementById('child-select');

  headerUserBadge.textContent = `${currentUser.parentName} | ${currentUser.schoolName}`;

  let children = [];
  let selectedChildId = null;

  async function apiCall(endpoint, method = 'GET', body = null) {
    const opts = { method, headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } };
    if (body && method !== 'GET') opts.body = JSON.stringify(body);
    const res = await fetch(endpoint, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // Load school settings (logo + name)
  async function loadSchoolSettings() {
    try {
      const settings = await apiCall('/api/parents/settings');
      const schoolName = settings.school_name || currentUser.schoolName;
      document.getElementById('sidebar-school-name').textContent = schoolName;
      if (settings.logo_path) {
        const logoSrc = settings.logo_path.startsWith('data:') ? settings.logo_path : '/' + settings.logo_path;
        const headerLogo = document.getElementById('header-school-logo');
        const sidebarLogo = document.getElementById('sidebar-school-logo');
        headerLogo.src = logoSrc;
        headerLogo.style.display = 'inline-block';
        sidebarLogo.src = logoSrc;
        sidebarLogo.style.display = 'block';
      }
    } catch (e) {}
  }
  loadSchoolSettings();

  function showToast(msg, isError = false) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.style.background = isError ? 'var(--danger)' : 'var(--primary)';
    t.style.display = 'block';
    setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  // Logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('skyhonix_token');
    localStorage.removeItem('skyhonix_user');
    window.location.href = 'index.html';
  });

  // Panel navigation
  window.showPanel = function(name) {
    document.querySelectorAll('.screen-section').forEach(p => p.style.display = 'none');
    document.getElementById(`panel-${name}`).style.display = '';
    document.querySelectorAll('.portal-sidebar nav a').forEach(a => a.classList.remove('active'));
    document.querySelector(`.portal-sidebar nav a[data-panel="${name}"]`).classList.add('active');
    const titles = { dashboard: 'Dashboard', fees: 'Fee Records', exams: 'Exam Results', attendance: 'Attendance', assignments: 'Homework & Tests', announcements: 'Announcements' };
    headerTitle.textContent = titles[name] || name;
    // Close sidebar only on mobile
    if (window.innerWidth <= 768) {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebar-overlay').style.display = 'none';
    }
    loadPanelData(name);
  };

  // Close sidebar when clicking outside on mobile
  document.getElementById('btn-hamburger').addEventListener('click', (e) => {
    e.stopPropagation();
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    sidebar.classList.toggle('open');
    overlay.style.display = sidebar.classList.contains('open') ? 'block' : 'none';
  });
  document.getElementById('sidebar-overlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').style.display = 'none';
  });

  // Child selector change
  childSelect.addEventListener('change', function() {
    selectedChildId = this.value ? parseInt(this.value) : null;
    const activePanel = document.querySelector('.portal-sidebar nav a.active');
    if (activePanel) loadPanelData(activePanel.dataset.panel);
  });

  // Load children
  async function loadChildren() {
    try {
      children = await apiCall('/api/parents/my-children');
      childSelect.innerHTML = '<option value="">-- Select Child --</option>';
      children.forEach(c => {
        childSelect.innerHTML += `<option value="${c.id}">${c.name} (${c.class_name}${c.section_name ? ' - ' + c.section_name : ''})</option>`;
      });
      if (children.length > 0) {
        childSelector.style.display = 'flex';
        selectedChildId = children[0].id;
        childSelect.value = selectedChildId;
      }
      document.getElementById('stat-children').textContent = children.length;
    } catch (e) {
      showToast(e.message, true);
    }
  }

  // Load panel data
  function loadPanelData(name) {
    switch (name) {
      case 'dashboard': loadDashboard(); break;
      case 'fees': loadFees(); break;
      case 'exams': loadExams(); break;
      case 'attendance': loadAttendance(); break;
      case 'assignments': loadParentAssignments(); break;
      case 'announcements': loadAnnouncements(); break;
    }
  }

  // ========== DASHBOARD ==========
  async function loadDashboard() {
    const container = document.getElementById('children-overview-container');
    if (!children.length) {
      container.innerHTML = '<p style="color: var(--text-muted);">No children linked to your account.</p>';
      return;
    }
    container.innerHTML = children.map(c => `
      <div class="record-card" style="display:flex; gap:16px; align-items:center;">
        <div style="width:50px; height:50px; border-radius:50%; background:var(--primary); display:flex; align-items:center; justify-content:center; color:white; font-size:1.2rem; flex-shrink:0;">
          ${c.photo ? `<img src="${c.photo}" style="width:50px; height:50px; border-radius:50%; object-fit:cover;">` : '🎓'}
        </div>
        <div>
          <strong>${c.name}</strong>
          <div style="color: var(--text-muted); font-size: 0.8rem;">Class: ${c.class_name}${c.section_name ? ' - ' + c.section_name : ''} | Roll: ${c.roll_no || '-'}</div>
          <div style="color: var(--text-muted); font-size: 0.8rem;">Father: ${c.father_name || '-'}</div>
        </div>
      </div>
    `).join('');

    if (selectedChildId) {
      try {
        const att = await apiCall(`/api/parents/my-attendance/${selectedChildId}?month=${String(new Date().getMonth() + 1).padStart(2, '0')}&year=${new Date().getFullYear()}`);
        const today = new Date().toISOString().split('T')[0];
        const todayRec = att.find(a => a.date === today);
        document.getElementById('stat-attendance').textContent = todayRec ? todayRec.status : 'No record';
        const feeData = await apiCall(`/api/parents/my-fees/${selectedChildId}`);
        const unpaid = feeData.ledger.filter(l => !l.paid_amount || l.paid_amount === 0).length;
        document.getElementById('stat-fees').textContent = unpaid;
        const examData = await apiCall(`/api/parents/my-exams/${selectedChildId}`);
        let totalMarks = 0;
        examData.forEach(r => { totalMarks += r.marks.length; });
        document.getElementById('stat-exams').textContent = totalMarks;
      } catch (e) {}
    }

    // Load dashboard assignments summary
    loadDashboardAssignments();
  }

  async function loadDashboardAssignments() {
    const container = document.getElementById('dashboard-assignments-container');
    if (!container) return;
    try {
      const assignments = await apiCall('/api/parents/my-assignments');
      if (assignments.length === 0) {
        container.innerHTML = `<div class="card" style="text-align:center; padding:30px;"><div style="font-size:2rem; margin-bottom:8px;">📚</div><p style="color:var(--text-muted);">No homework or tests assigned yet.</p></div>`;
        return;
      }
      const typeLabels = { homework: 'Homework', monthly_test: 'Monthly Test', class_test: 'Class Test', quiz: 'Quiz', project: 'Project', other: 'Other' };
      const typeColors = { homework: '#6366f1', monthly_test: '#f59e0b', class_test: '#ef4444', quiz: '#10b981', project: '#8b5cf6', other: '#64748b' };
      const recent = assignments.slice(0, 4);
      container.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(250px, 1fr)); gap:12px;">` +
        recent.map(a => {
          const due = a.due_date ? new Date(a.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
          const isOverdue = a.due_date && new Date(a.due_date) < new Date();
          const daysLeft = a.due_date ? Math.ceil((new Date(a.due_date) - new Date()) / (1000 * 60 * 60 * 24)) : null;
          let dueInfo = '';
          if (isOverdue) dueInfo = '<span style="color:#ef4444; font-size:0.75rem; font-weight:600;">OVERDUE</span>';
          else if (daysLeft !== null && daysLeft <= 2 && daysLeft >= 0) dueInfo = '<span style="color:#f59e0b; font-size:0.75rem; font-weight:600;">DUE SOON</span>';

          return `<div class="card" style="border-left:4px solid ${typeColors[a.type] || '#6366f1'}; cursor:pointer;" onclick="showPanel('assignments')">
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;"><span style="background:${typeColors[a.type]}; color:#fff; padding:1px 8px; border-radius:12px; font-size:0.7rem;">${typeLabels[a.type]}</span> ${dueInfo}</div>
            <h4 style="margin:0; font-size:0.9rem;">${esc(a.title)}</h4>
            <div style="font-size:0.8rem; color:var(--text-muted);">${esc(a.subject)} · ${esc(a.teacher_name || 'Teacher')} ${due ? '· Due ' + due : ''}</div>
          </div>`;
        }).join('') + `</div>`;
    } catch (err) {}
  }

  // ========== FEES ==========
  async function loadFees() {
    const container = document.getElementById('fees-container');
    if (!selectedChildId) { container.innerHTML = '<p style="color: var(--text-muted);">Select a child first.</p>'; return; }
    try {
      const data = await apiCall(`/api/parents/my-fees/${selectedChildId}`);
      const feePerMonth = data.feeSettings ? (data.feeSettings.monthly_fee || 0) : 0;

      let html = `<div style="margin-bottom:16px; color: var(--text-muted); font-size: 0.85rem;">Monthly Fee: <strong>Rs. ${feePerMonth}</strong></div>`;

      if (!data.ledger || data.ledger.length === 0) {
        html += '<p style="color: var(--text-muted);">No fee records found.</p>';
      } else {
        html += '<div class="fee-grid">';
        data.ledger.forEach(entry => {
          const total = entry.total_payable || 0;
          const paid = entry.paid_amount || 0;
          const remaining = total - paid;
          const status = entry.status || (remaining <= 0 ? 'Paid' : paid > 0 ? 'Partial' : 'Unpaid');
          const cardClass = status === 'Paid' ? 'paid' : 'unpaid';
          html += `<div class="month-card ${cardClass}">
            <div class="month-name">${entry.month ? entry.month.substring(0, 3) : '-'}</div>
            <div style="font-size:0.7rem; color: var(--text-muted);">${entry.year || ''}</div>
            <div class="amount">Rs. ${paid} / Rs. ${total}</div>
            <div style="font-size:0.7rem; margin-top:2px;">
              <span class="badge ${status === 'Paid' ? 'badge-green' : status === 'Partial' ? 'badge-yellow' : 'badge-red'}">${status}</span>
            </div>
            ${entry.discount > 0 ? `<div style="color:#22c55e; font-size:0.7rem;">Discount: Rs. ${entry.discount}</div>` : ''}
            ${remaining > 0 ? `<div style="color:#ef4444; font-size:0.7rem;">Due: Rs. ${remaining}</div>` : ''}
          </div>`;
        });
        html += '</div>';
      }
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<p style="color: var(--danger);">${e.message}</p>`;
    }
  }

  // ========== EXAMS ==========
  async function loadExams() {
    const container = document.getElementById('exams-container');
    if (!selectedChildId) { container.innerHTML = '<p style="color: var(--text-muted);">Select a child first.</p>'; return; }
    try {
      const results = await apiCall(`/api/parents/my-exams/${selectedChildId}`);
      if (results.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted);">No exam results found.</p>';
        return;
      }
      let html = '';
      results.forEach(r => {
        let totalMarks = 0, obtainedMarks = 0;
        const subjectResults = [];
        r.marks.forEach(m => {
          totalMarks += (m.max_marks || 100);
          obtainedMarks += (m.marks || 0);
          const pct = m.max_marks ? ((m.marks || 0) / m.max_marks * 100) : 0;
          subjectResults.push({ subject: m.subject, marks: m.marks || 0, max: m.max_marks || 100, pct });
        });
        const pct = totalMarks > 0 ? ((obtainedMarks / totalMarks) * 100).toFixed(1) : 0;

        // Overall tips
        let gradeColor = '#22c55e', grade = 'Excellent';
        if (pct < 50) { gradeColor = '#ef4444'; grade = 'Needs Serious Improvement'; }
        else if (pct < 60) { gradeColor = '#f97316'; grade = 'Below Average'; }
        else if (pct < 70) { gradeColor = '#f59e0b'; grade = 'Average'; }
        else if (pct < 80) { gradeColor = '#3b82f6'; grade = 'Good'; }
        else if (pct < 90) { gradeColor = '#22c55e'; grade = 'Very Good'; }

        // Weak/strong subjects
        const weak = subjectResults.filter(s => s.pct < 50).map(s => s.subject);
        const strong = subjectResults.filter(s => s.pct >= 80).map(s => s.subject);

        let tips = '';
        if (pct < 50) tips = 'Your child is struggling. Consider extra tutoring or speaking with the class teacher.';
        else if (pct < 60) tips = 'Room for improvement. Help your child set a daily study routine.';
        else if (pct < 70) tips = 'Average performance. Encourage consistent practice, especially in weaker subjects.';
        else if (pct < 80) tips = 'Good job! Keep supporting your child\'s study habits.';
        else tips = 'Excellent performance! Your child is doing great. Keep it up!';

        html += `<div class="record-card">
          <h4>${r.exam.exam_name} (${r.exam.year})</h4>
          <div style="font-size:0.8rem; color: var(--text-muted); margin-bottom:8px;">
            Term: ${r.marks[0] ? r.marks[0].term : '-'} | Total: ${obtainedMarks}/${totalMarks} | <strong style="color:${gradeColor};">${pct}% - ${grade}</strong>
          </div>
          <table class="data-table" style="margin-top:8px;">
            <thead><tr><th>Subject</th><th>Obtained</th><th>Max</th><th>%</th></tr></thead>
            <tbody>`;
        subjectResults.forEach(s => {
          const color = s.pct >= 80 ? '#22c55e' : s.pct >= 50 ? '#f59e0b' : '#ef4444';
          html += `<tr>
            <td>${s.subject || '-'}</td>
            <td><strong>${s.marks}</strong></td>
            <td>${s.max}</td>
            <td style="color:${color}; font-weight:600;">${s.pct.toFixed(0)}%</td>
          </tr>`;
        });
        html += `</tbody></table>`;

        // Tips box
        html += `<div style="margin-top:12px; padding:12px; border-radius:8px; background:rgba(59,130,246,0.08); border-left:3px solid ${gradeColor}; font-size:0.82rem; color:var(--text-primary);">
          <strong style="color:${gradeColor};">Tip:</strong> ${tips}
        </div>`;

        // Weak/strong subjects
        if (weak.length || strong.length) {
          html += `<div style="margin-top:8px; display:flex; gap:12px; font-size:0.8rem; flex-wrap:wrap;">`;
          if (strong.length) html += `<span style="color:#22c55e;">Strong: ${strong.join(', ')}</span>`;
          if (weak.length) html += `<span style="color:#ef4444;">Needs Focus: ${weak.join(', ')}</span>`;
          html += `</div>`;
        }

        html += `</div>`;
      });
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<p style="color: var(--danger);">${e.message}</p>`;
    }
  }

  // ========== ATTENDANCE ==========
  async function loadAttendance() {
    const container = document.getElementById('attendance-container');
    if (!selectedChildId) { container.innerHTML = '<p style="color: var(--text-muted);">Select a child first.</p>'; return; }

    const monthSelect = document.getElementById('att-month');
    const yearSelect = document.getElementById('att-year');
    if (!monthSelect.options.length) {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      months.forEach((m, i) => {
        monthSelect.innerHTML += `<option value="${String(i + 1).padStart(2, '0')}" ${i === new Date().getMonth() ? 'selected' : ''}>${m}</option>`;
      });
      for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 2; y--) {
        yearSelect.innerHTML += `<option value="${y}" ${y === new Date().getFullYear() ? 'selected' : ''}>${y}</option>`;
      }
    }

    const month = monthSelect.value;
    const year = yearSelect.value;
    try {
      const att = await apiCall(`/api/parents/my-attendance/${selectedChildId}?month=${month}&year=${year}`);
      if (att.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted);">No attendance records found for this period.</p>';
        return;
      }
      let present = 0, absent = 0, late = 0, total = att.length;
      att.forEach(a => { if (a.status === 'Present') present++; else if (a.status === 'Absent') absent++; else if (a.status === 'Late') late++; });

      let html = `<div style="display:flex; gap:16px; margin-bottom:16px; flex-wrap:wrap;">
        <div class="stat-card" style="flex:1; min-width:100px;"><h3 style="color:#22c55e;">${present}</h3><p>Present</p></div>
        <div class="stat-card" style="flex:1; min-width:100px;"><h3 style="color:#ef4444;">${absent}</h3><p>Absent</p></div>
        <div class="stat-card" style="flex:1; min-width:100px;"><h3 style="color:#f59e0b;">${late}</h3><p>Late</p></div>
        <div class="stat-card" style="flex:1; min-width:100px;"><h3>${total}</h3><p>Total Days</p></div>
      </div>`;

      html += `<table class="data-table"><thead><tr><th>Date</th><th>Status</th><th>Check In</th></tr></thead><tbody>`;
      att.forEach(a => {
        const badge = a.status === 'Present' ? 'badge-green' : a.status === 'Absent' ? 'badge-red' : 'badge-yellow';
        html += `<tr>
          <td>${a.date}</td>
          <td><span class="badge ${badge}">${a.status}</span></td>
          <td>${a.time || '-'}</td>
        </tr>`;
      });
      html += '</tbody></table>';
      container.innerHTML = html;
    } catch (e) {
      container.innerHTML = `<p style="color: var(--danger);">${e.message}</p>`;
    }
  }

  document.getElementById('att-month').addEventListener('change', loadAttendance);
  document.getElementById('att-year').addEventListener('change', loadAttendance);

  // ========== ASSIGNMENTS (Homework & Tests) ==========
  let cachedParentAssignments = [];

  async function loadParentAssignments() {
    const container = document.getElementById('parent-assignments-list');
    try {
      const assignments = await apiCall('/api/parents/my-assignments');
      cachedParentAssignments = assignments;

      // Populate subject filter
      const subjects = [...new Set(assignments.map(a => a.subject))];
      const subjectSel = document.getElementById('assignment-filter-subject');
      const currentSubject = subjectSel.value;
      subjectSel.innerHTML = '<option value="">All Subjects</option>' + subjects.map(s => `<option value="${esc(s)}" ${s === currentSubject ? 'selected' : ''}>${esc(s)}</option>`).join('');

      renderParentAssignments();
    } catch (err) {
      container.innerHTML = `<p style="color: var(--danger);">${err.message}</p>`;
    }
  }

  function renderParentAssignments() {
    const container = document.getElementById('parent-assignments-list');
    let filtered = cachedParentAssignments;

    const typeFilter = document.getElementById('assignment-filter-type').value;
    const subjectFilter = document.getElementById('assignment-filter-subject').value;

    if (typeFilter) filtered = filtered.filter(a => a.type === typeFilter);
    if (subjectFilter) filtered = filtered.filter(a => a.subject === subjectFilter);

    if (filtered.length === 0) {
      container.innerHTML = `
        <div class="card" style="text-align:center; padding:40px;">
          <div style="font-size:3rem; margin-bottom:12px;">📚</div>
          <h3 style="color:var(--text-muted); font-weight:500;">No Assignments Found</h3>
          <p style="color:var(--text-muted); font-size:0.9rem;">${cachedParentAssignments.length === 0 ? 'No homework or tests have been assigned yet.' : 'No assignments match your filters.'}</p>
        </div>`;
      return;
    }

    const typeLabels = { homework: 'Homework', monthly_test: 'Monthly Test', class_test: 'Class Test', quiz: 'Quiz', project: 'Project', other: 'Other' };
    const typeColors = { homework: '#6366f1', monthly_test: '#f59e0b', class_test: '#ef4444', quiz: '#10b981', project: '#8b5cf6', other: '#64748b' };
    const typeIcons = { homework: '📝', monthly_test: '📊', class_test: '📋', quiz: '❓', project: '🎯', other: '📌' };
    const priorityColors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };

    container.innerHTML = filtered.map(a => {
      const due = a.due_date ? new Date(a.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'No due date';
      const created = new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const isOverdue = a.due_date && new Date(a.due_date) < new Date();
      const daysUntilDue = a.due_date ? Math.ceil((new Date(a.due_date) - new Date()) / (1000 * 60 * 60 * 24)) : null;

      let dueBadge = '';
      if (isOverdue) {
        dueBadge = '<span style="background:#ef4444; color:#fff; padding:2px 8px; border-radius:20px; font-size:0.7rem; font-weight:600;">OVERDUE</span>';
      } else if (daysUntilDue !== null && daysUntilDue <= 2 && daysUntilDue >= 0) {
        dueBadge = '<span style="background:#f59e0b; color:#fff; padding:2px 8px; border-radius:20px; font-size:0.7rem; font-weight:600;">DUE SOON</span>';
      }

      return `
        <div class="card" style="margin-bottom:12px; border-left: 4px solid ${typeColors[a.type] || '#6366f1'};">
          <div style="display:flex; align-items:flex-start; gap:12px;">
            <div style="font-size:2rem; line-height:1;">${typeIcons[a.type] || '📌'}</div>
            <div style="flex:1;">
              <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px; flex-wrap:wrap;">
                <span style="background:${typeColors[a.type] || '#6366f1'}; color:#fff; padding:2px 10px; border-radius:20px; font-size:0.75rem; font-weight:600;">${typeLabels[a.type] || a.type}</span>
                <span style="background:${priorityColors[a.priority] || '#f59e0b'}; color:#fff; padding:2px 8px; border-radius:20px; font-size:0.7rem; font-weight:600;">${(a.priority || 'medium').toUpperCase()}</span>
                ${dueBadge}
              </div>
              <h4 style="margin:0 0 4px; font-size:1.05rem;">${esc(a.title)}</h4>
              <div style="font-size:0.85rem; color:var(--text-muted); margin-bottom:6px;">
                📘 ${esc(a.subject)} &nbsp;|&nbsp; 👨‍🏫 ${esc(a.teacher_name || 'Teacher')} &nbsp;|&nbsp; 📋 ${esc(a.class_name)}${a.section_name ? ' - ' + esc(a.section_name) : ''}
              </div>
              ${a.description ? `<div style="background:var(--glass-bg); border:1px solid var(--border-glow); border-radius:8px; padding:10px 14px; margin:8px 0; font-size:0.85rem; color:var(--text-secondary); white-space:pre-line;">${esc(a.description)}</div>` : ''}
              ${a.student_name ? `<div style="font-size:0.8rem; color:var(--text-muted); margin-top:4px;">👦 Student: <strong>${esc(a.student_name)}</strong></div>` : ''}
              <div style="margin-top:8px; font-size:0.8rem; color:var(--text-muted);">
                📅 Due: <strong style="color:${isOverdue ? 'var(--danger)' : 'var(--text-primary)'}">${due}</strong> &nbsp;|&nbsp; Posted: ${created}
              </div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  document.getElementById('assignment-filter-type').addEventListener('change', renderParentAssignments);
  document.getElementById('assignment-filter-subject').addEventListener('change', renderParentAssignments);

  // ========== ANNOUNCEMENTS ==========
  let cachedAnnouncements = [];

  async function loadAnnouncements() {
    const container = document.getElementById('announcements-container');
    try {
      const announcements = await apiCall('/api/parents/announcements');
      cachedAnnouncements = announcements;

      // Render full announcements list in the announcements panel
      if (announcements.length === 0) {
        container.innerHTML = '<p style="color: var(--text-muted);">No announcements.</p>';
      } else {
        container.innerHTML = announcements.map(a => {
          const date = a.created_at ? new Date(a.created_at) : null;
          const dateStr = date ? date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
          const timeStr = date ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';
          return `
          <div class="record-card">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
              <h4 style="margin:0;">${a.title}</h4>
              <div style="display:flex; gap:8px; align-items:center;">
                <span style="background:rgba(99,102,241,0.15); color:var(--primary); padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:600;">${a.target_role === 'all' ? '📢 All' : a.target_role === 'parents' ? '👨‍👩‍👧 Parents' : '👩‍🏫 Teachers'}</span>
              </div>
            </div>
            <p style="margin: 8px 0; color: var(--text); line-height:1.5;">${a.message || ''}</p>
            <div style="display:flex; align-items:center; gap:12px; margin-top:10px; font-size:0.78rem; color:var(--text-muted); padding-top:10px; border-top:1px solid var(--border-glow);">
              <span>📅 ${dateStr}</span>
              <span>🕐 ${timeStr}</span>
              ${a.created_by ? `<span>👤 ${a.created_by}</span>` : ''}
            </div>
          </div>`;
        }).join('');
      }

      // News ticker
      if (announcements.length > 0) {
        const ticker = document.getElementById('news-ticker');
        const tickerContent = document.getElementById('ticker-content');
        ticker.style.display = 'block';
        const items = announcements.map(a => `<span class="ticker-item"><span class="ticker-label">NEWS</span>${a.title} - ${a.message.substring(0, 80)}</span>`).join('');
        tickerContent.innerHTML = items + items;
      }

      // Render dashboard announcements
      renderDashboardAnnouncements(announcements);
    } catch (e) {
      container.innerHTML = `<p style="color: var(--danger);">${e.message}</p>`;
    }
  }

  function renderDashboardAnnouncements(announcements) {
    const container = document.getElementById('dashboard-announcements-container');
    if (!container) return;

    if (announcements.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px 20px; background:rgba(255,255,255,0.02); border-radius:16px; border:1px dashed var(--border-glow);">
          <div style="font-size:2.5rem; margin-bottom:10px;">📭</div>
          <p style="color:var(--text-muted);">No announcements yet.</p>
        </div>`;
      return;
    }

    const colors = [
      { bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.25)', accent: '#6366f1', icon: '📋' },
      { bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.25)', accent: '#10b981', icon: '✅' },
      { bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.25)', accent: '#f59e0b', icon: '⚠️' },
      { bg: 'rgba(236, 72, 153, 0.08)', border: 'rgba(236, 72, 153, 0.25)', accent: '#ec4899', icon: '📢' }
    ];

    let html = '';
    announcements.slice(0, 5).forEach((a, idx) => {
      const c = colors[idx % colors.length];
      const date = a.created_at ? new Date(a.created_at) : null;
      const dateStr = date ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      const timeStr = date ? date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';

      html += `
        <div class="record-card" style="background:${c.bg}; border:1px solid ${c.border}; border-left:4px solid ${c.accent}; padding:18px 20px; margin-bottom:12px; transition:transform 0.2s, box-shadow 0.2s; cursor:default;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 20px rgba(0,0,0,0.1)'" onmouseout="this.style.transform='none'; this.style.boxShadow='none'">
          <div style="display:flex; align-items:flex-start; gap:14px;">
            <div style="font-size:1.6rem; line-height:1; flex-shrink:0; margin-top:2px;">${c.icon}</div>
            <div style="flex:1; min-width:0;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
                <h4 style="margin:0; font-size:1rem; font-weight:700; color:var(--text-primary);">${a.title}</h4>
              </div>
              ${a.message ? `<p style="margin:8px 0 0; font-size:0.88rem; color:var(--text-muted); line-height:1.5; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;">${a.message}</p>` : ''}
              <div style="display:flex; align-items:center; gap:12px; margin-top:10px; font-size:0.75rem; color:var(--text-muted);">
                <span>📅 ${dateStr}</span>
                <span>🕐 ${timeStr}</span>
                ${a.created_by ? `<span>👤 ${a.created_by}</span>` : ''}
              </div>
            </div>
          </div>
        </div>`;
    });

    if (announcements.length > 5) {
      html += `<div style="text-align:center; padding:12px; color:var(--text-muted); font-size:0.85rem; cursor:pointer;" onclick="showPanel('announcements')">
        View all ${announcements.length} announcements →
      </div>`;
    }

    container.innerHTML = html;
  }

  // ========== INIT ==========
  loadChildren().then(() => {
    loadDashboard();
    loadAnnouncements();
  });
})();
