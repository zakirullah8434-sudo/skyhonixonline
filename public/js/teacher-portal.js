// Teacher Portal - SkyHonix School System

function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

document.addEventListener('DOMContentLoaded', () => {
  // Auth Guard
  const token = localStorage.getItem('skyhonix_token');
  const userJson = localStorage.getItem('skyhonix_user');

  if (!token || !userJson) {
    window.location.href = 'index.html';
    return;
  }

  const currentUser = JSON.parse(userJson);

  if (currentUser.role !== 'teacher') {
    window.location.href = 'portal.html';
    return;
  }

  // Display user info
  const headerUserBadge = document.getElementById('header-user-badge');
  headerUserBadge.textContent = `${currentUser.teacherName} | ${currentUser.schoolName}`;

  // API Helper
  async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };
    if (body && method !== 'GET') {
      options.body = JSON.stringify(body);
    }
    const response = await fetch(endpoint, options);
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Server returned an invalid response. Please try again.'); }
    if (!response.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  // Load school settings (logo + name)
  async function loadSchoolSettings() {
    try {
      const settings = await apiCall('/api/teachers/settings');
      const schoolName = settings.school_name || currentUser.schoolName;
      document.getElementById('header-school-title').textContent = schoolName;
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

  // Toast
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toast-text');
  function showToast(msg, isError = false) {
    toastText.innerText = msg;
    toast.style.borderColor = isError ? 'var(--danger)' : 'var(--primary)';
    toast.style.display = 'block';
    setTimeout(() => { toast.style.display = 'none'; }, 3000);
  }

  // Sidebar Navigation
  const sidebarToggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('main-sidebar');
  sidebarToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('open');
  });

  // Close sidebar when clicking outside on mobile
  document.getElementById('main-content').addEventListener('click', () => {
    sidebar.classList.remove('open');
  });

  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('.content-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + btn.dataset.opt).classList.add('active');
      sidebar.classList.remove('open');
    });
  });

  // Logout
  document.getElementById('btn-logout').addEventListener('click', () => {
    localStorage.removeItem('skyhonix_token');
    localStorage.removeItem('skyhonix_user');
    window.location.href = 'index.html';
  });

  // ==================== NEWS TICKER ====================
  let cachedAnnouncements = [];

  async function loadNewsTicker() {
    try {
      const announcements = await apiCall('/api/teachers/announcements');
      cachedAnnouncements = announcements;
      const ticker = document.getElementById('news-ticker');
      const tickerContent = document.getElementById('news-ticker-content');
      if (!ticker || !tickerContent) return;

      if (announcements.length === 0) {
        ticker.style.display = 'none';
        return;
      }

      ticker.style.display = 'block';
      tickerContent.innerHTML = announcements.map(a => {
        const date = a.created_at ? new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
        return `<span style="color: #fff; font-size: 0.9rem;"><strong>${a.title}</strong> — ${a.message ? a.message.substring(0, 80) : ''}${a.message && a.message.length > 80 ? '...' : ''} <small style="opacity: 0.7;">(${date})</small></span>`;
      }).join('');

      renderDashboardAnnouncements(announcements);
    } catch (e) {}
  }
  loadNewsTicker();

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
      const targetBadge = a.target_role === 'all' ? 'All Staff' : a.target_role === 'teachers' ? 'Teachers' : 'Parents';

      html += `
        <div style="background:${c.bg}; border:1px solid ${c.border}; border-left:4px solid ${c.accent}; border-radius:12px; padding:18px 20px; margin-bottom:12px; transition:transform 0.2s, box-shadow 0.2s; cursor:default;" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 4px 20px rgba(0,0,0,0.1)'" onmouseout="this.style.transform='none'; this.style.boxShadow='none'">
          <div style="display:flex; align-items:flex-start; gap:14px;">
            <div style="font-size:1.6rem; line-height:1; flex-shrink:0; margin-top:2px;">${c.icon}</div>
            <div style="flex:1; min-width:0;">
              <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; flex-wrap:wrap;">
                <h3 style="margin:0; font-size:1rem; font-weight:700; color:var(--text-primary);">${a.title}</h3>
                <div style="display:flex; gap:8px; align-items:center; flex-shrink:0;">
                  <span style="background:${c.accent}22; color:${c.accent}; padding:3px 10px; border-radius:12px; font-size:0.7rem; font-weight:600;">${targetBadge}</span>
                </div>
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
      html += `<div style="text-align:center; padding:12px; color:var(--text-muted); font-size:0.85rem; cursor:pointer;" onclick="document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active')); document.querySelector('[data-opt=announcements]').classList.add('active'); document.querySelectorAll('.content-panel').forEach(p=>p.classList.remove('active')); document.getElementById('panel-announcements').classList.add('active');">
        View all ${announcements.length} announcements →
      </div>`;
    }

    container.innerHTML = html;
  }

  // ==================== MY SUBJECTS ====================
  async function loadMySubjects() {
    const container = document.getElementById('my-subjects-container');
    container.innerHTML = '<p style="color:var(--text-muted);">Loading...</p>';
    try {
      const data = await apiCall('/api/teachers/my-subjects');
      if (data.subjects.length === 0) {
        container.innerHTML = '<div class="card" style="padding:20px; text-align:center; color:var(--text-muted);">No subjects assigned yet. Contact school admin.</div>';
        return;
      }
      let html = '';
      data.subjects.forEach(group => {
        html += `<div class="card" style="padding:20px; margin-bottom:15px;">`;
        html += `<h3 style="color:var(--primary); margin-bottom:10px;">${group.subject}</h3>`;
        html += `<div style="overflow-x:auto; -webkit-overflow-scrolling:touch;">`;
        html += `<table style="width:100%; border-collapse:collapse; min-width:500px;">`;
        html += `<thead><tr>
          <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-glow); font-size:0.85rem;">Class</th>
          <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-glow); font-size:0.85rem;">Day</th>
          <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-glow); font-size:0.85rem;">Time</th>
          <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-glow); font-size:0.85rem;">Period</th>
          <th style="text-align:left; padding:8px; border-bottom:1px solid var(--border-glow); font-size:0.85rem;">Room</th>
        </tr></thead><tbody>`;
        group.entries.forEach(e => {
          html += `<tr>
            <td style="padding:8px; border-bottom:1px solid var(--border-glow);">${e.class_name}${e.section_name ? ' - ' + e.section_name : ''}</td>
            <td style="padding:8px; border-bottom:1px solid var(--border-glow);">${e.day}</td>
            <td style="padding:8px; border-bottom:1px solid var(--border-glow);">${e.start_time || '-'} to ${e.end_time || '-'}</td>
            <td style="padding:8px; border-bottom:1px solid var(--border-glow);">${e.period}</td>
            <td style="padding:8px; border-bottom:1px solid var(--border-glow);">${e.room || '-'}</td>
          </tr>`;
        });
        html += `</tbody></table></div></div>`;
      });
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `<div class="card" style="padding:20px; color:var(--danger);">Error: ${err.message}</div>`;
    }
  }

  // ==================== MARKS ENTRY ====================
  let assignedClasses = [];

  async function loadMarksFilters() {
    try {
      // Load exams
      const exams = await apiCall('/api/teachers/exams');
      const examSelect = document.getElementById('marks-exam-select');
      examSelect.innerHTML = '<option value="">-- Select Exam --</option>';
      exams.forEach(ex => {
        examSelect.innerHTML += `<option value="${ex.id}">${ex.exam_name} (${ex.year})</option>`;
      });

      // Load assigned classes
      assignedClasses = await apiCall('/api/teachers/my-classes');
      const classSelect = document.getElementById('marks-class-select');
      classSelect.innerHTML = '<option value="">-- Select Class --</option>';
      const uniqueClasses = [...new Set(assignedClasses.map(c => c.class_name))];
      uniqueClasses.forEach(cn => {
        classSelect.innerHTML += `<option value="${cn}">${cn}</option>`;
      });
    } catch (err) {
      showToast('Failed to load filters: ' + err.message, true);
    }
  }

  document.getElementById('marks-class-select').addEventListener('change', function() {
    const selectedClass = this.value;
    const subjectSelect = document.getElementById('marks-subject-select');
    subjectSelect.innerHTML = '<option value="">-- Select Subject --</option>';
    if (!selectedClass) return;
    const subjects = [...new Set(assignedClasses.filter(c => c.class_name === selectedClass).map(c => c.subject))];
    subjects.forEach(s => {
      subjectSelect.innerHTML += `<option value="${s}">${s}</option>`;
    });
  });

  let currentMarksData = [];

  document.getElementById('btn-load-marks').addEventListener('click', async () => {
    const examId = document.getElementById('marks-exam-select').value;
    const term = document.getElementById('marks-term-select').value;
    const className = document.getElementById('marks-class-select').value;
    const subject = document.getElementById('marks-subject-select').value;

    if (!examId || !term || !className || !subject) {
      showToast('Please select all filters first', true);
      return;
    }

    try {
      const grid = await apiCall(`/api/teachers/my-marks?exam_id=${examId}&class_name=${className}&subject=${subject}&term=${term}`);
      currentMarksData = grid;

      // Use max_marks from backend response, fallback to 100
      const maxMarks = grid.length > 0 && grid[0].max_marks !== undefined ? grid[0].max_marks : 100;
      document.getElementById('marks-max-input').value = maxMarks;
      document.getElementById('marks-max-label').textContent = `(out of ${maxMarks})`;

      document.getElementById('marks-grid-title').textContent = `${subject} - ${className} (${term})`;
      const tbody = document.getElementById('marks-grid-body');
      tbody.innerHTML = '';

      grid.forEach((student, idx) => {
        const tr = document.createElement('tr');
        tr.style.background = idx % 2 === 0 ? 'transparent' : 'rgba(99,102,241,0.05)';
        tr.innerHTML = `
          <td style="padding:10px; border-bottom:1px solid var(--border-glow); font-weight:500;">${student.roll_no || '-'}</td>
          <td style="padding:10px; border-bottom:1px solid var(--border-glow);">${student.name}</td>
          <td style="padding:10px; border-bottom:1px solid var(--border-glow); text-align:center;">
            <input type="number" min="0" max="${maxMarks}" class="form-control" style="width:100px; margin:0 auto; text-align:center;"
              value="${student.marks !== '' ? student.marks : ''}"
              data-student-id="${student.id}">
          </td>
        `;
        tbody.appendChild(tr);
      });

      document.getElementById('marks-grid-container').style.display = 'block';
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });

  // Update max attribute on all inputs when max marks changes
  document.getElementById('marks-max-input').addEventListener('input', function() {
    const val = parseInt(this.value) || 100;
    document.getElementById('marks-max-label').textContent = `(out of ${val})`;
    document.querySelectorAll('#marks-grid-body input[type="number"]').forEach(input => {
      input.setAttribute('max', val);
    });
  });

  document.getElementById('btn-save-marks').addEventListener('click', async () => {
    const examId = document.getElementById('marks-exam-select').value;
    const term = document.getElementById('marks-term-select').value;
    const className = document.getElementById('marks-class-select').value;
    const subject = document.getElementById('marks-subject-select').value;
    const maxMarks = parseInt(document.getElementById('marks-max-input').value) || 100;

    const marksList = [];
    document.querySelectorAll('#marks-grid-body input[type="number"]').forEach(input => {
      marksList.push({
        student_id: parseInt(input.dataset.studentId),
        marks: input.value
      });
    });

    try {
      await apiCall('/api/teachers/my-marks', 'POST', {
        exam_id: parseInt(examId),
        subject,
        term,
        class_name: className,
        max_marks: maxMarks,
        marksList
      });
      showToast('Marks saved successfully!');
    } catch (err) {
      showToast('Error saving marks: ' + err.message, true);
    }
  });

  // ==================== ANNOUNCEMENTS ====================
  async function loadAnnouncements() {
    const container = document.getElementById('announcements-container');
    container.innerHTML = '<p style="color:var(--text-muted);">Loading...</p>';
    try {
      const announcements = await apiCall('/api/teachers/announcements');
      if (announcements.length === 0) {
        container.innerHTML = `
          <div style="text-align:center; padding:60px 20px; background: rgba(255,255,255,0.02); border-radius:16px; border: 1px dashed var(--border-glow);">
            <div style="font-size:3rem; margin-bottom:15px;">📭</div>
            <h3 style="color:var(--text-muted); font-weight:500;">No Announcements Yet</h3>
            <p style="color:var(--text-muted); font-size:0.9rem;">School administration hasn't posted any announcements.</p>
          </div>`;
        return;
      }
      let html = '';
      announcements.forEach((a, idx) => {
        const date = a.created_at ? new Date(a.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
        const colors = [
          { bg: 'rgba(99, 102, 241, 0.08)', border: 'rgba(99, 102, 241, 0.3)', icon: '📋' },
          { bg: 'rgba(16, 185, 129, 0.08)', border: 'rgba(16, 185, 129, 0.3)', icon: '✅' },
          { bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.3)', icon: '⚠️' },
          { bg: 'rgba(236, 72, 153, 0.08)', border: 'rgba(236, 72, 153, 0.3)', icon: '📢' }
        ];
        const c = colors[idx % colors.length];
        html += `
          <div style="background:${c.bg}; border:1px solid ${c.border}; border-radius:16px; padding:24px; margin-bottom:16px; transition: transform 0.2s ease;" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform='none'">
            <div style="display:flex; align-items:flex-start; gap:16px;">
              <div style="font-size:2rem; line-height:1; flex-shrink:0;">${c.icon}</div>
              <div style="flex:1;">
                <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:8px; flex-wrap:wrap; gap:8px;">
                  <h3 style="margin:0; color:var(--text-primary); font-size:1.15rem;">${a.title}</h3>
                  <div style="display:flex; gap:8px; align-items:center;">
                    <span style="background:rgba(99,102,241,0.15); color:var(--primary); padding:3px 10px; border-radius:12px; font-size:0.75rem; font-weight:600;">${a.target_role === 'all' ? '📢 All' : a.target_role === 'teachers' ? '👩‍🏫 Teachers' : '👨‍👩‍👧 Parents'}</span>
                    <small style="color:var(--text-muted);">${date}</small>
                  </div>
                </div>
                <p style="color:var(--text-muted); margin:10px 0 0; font-size:0.95rem; line-height:1.6; white-space:pre-wrap;">${a.message || ''}</p>
                ${a.created_by ? `<div style="margin-top:12px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.05);">
                  <small style="color:var(--text-muted);">Posted by <strong style="color:var(--text-primary);">${a.created_by}</strong></small>
                </div>` : ''}
              </div>
            </div>
          </div>`;
      });
      container.innerHTML = html;
    } catch (err) {
      container.innerHTML = `
        <div style="text-align:center; padding:40px 20px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.3); border-radius:16px;">
          <div style="font-size:2rem; margin-bottom:10px;">⚠️</div>
          <p style="color:var(--danger);">Error loading announcements: ${err.message}</p>
        </div>`;
    }
  }

  // ==================== ASSIGNMENTS ====================
  let cachedAssignments = [];
  let cachedTimetableClasses = [];

  async function loadAssignments() {
    const container = document.getElementById('assignments-list');
    try {
      const assignments = await apiCall('/api/teachers/assignments');
      cachedAssignments = assignments;

      if (assignments.length === 0) {
        container.innerHTML = `
          <div style="text-align:center; padding:40px; color:var(--text-muted);">
            <div style="font-size:3rem; margin-bottom:12px;">📚</div>
            <h3 style="font-weight:500;">No Assignments Yet</h3>
            <p style="font-size:0.9rem;">Click "New Assignment" to create homework, tests, or projects for your students.</p>
          </div>`;
        return;
      }

      const typeLabels = { homework: 'Homework', monthly_test: 'Monthly Test', class_test: 'Class Test', quiz: 'Quiz', project: 'Project', other: 'Other' };
      const typeColors = { homework: '#6366f1', monthly_test: '#f59e0b', class_test: '#ef4444', quiz: '#10b981', project: '#8b5cf6', other: '#64748b' };
      const priorityColors = { low: '#10b981', medium: '#f59e0b', high: '#ef4444' };

      container.innerHTML = assignments.map(a => {
        const due = a.due_date ? new Date(a.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : 'No due date';
        const created = new Date(a.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
        const isOverdue = a.due_date && new Date(a.due_date) < new Date();
        return `
          <div class="card" style="margin-bottom:12px; border-left: 4px solid ${typeColors[a.type] || '#6366f1'};">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:8px;">
              <div style="flex:1; min-width:200px;">
                <div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">
                  <span style="background:${typeColors[a.type] || '#6366f1'}; color:#fff; padding:2px 10px; border-radius:20px; font-size:0.75rem; font-weight:600;">${typeLabels[a.type] || a.type}</span>
                  <span style="background:${priorityColors[a.priority] || '#f59e0b'}; color:#fff; padding:2px 8px; border-radius:20px; font-size:0.7rem; font-weight:600;">${(a.priority || 'medium').toUpperCase()}</span>
                  ${isOverdue ? '<span style="background:#ef4444; color:#fff; padding:2px 8px; border-radius:20px; font-size:0.7rem; font-weight:600;">OVERDUE</span>' : ''}
                </div>
                <h4 style="margin:0 0 4px;">${esc(a.title)}</h4>
                <div style="font-size:0.85rem; color:var(--text-muted);">
                  📘 ${esc(a.subject)} &nbsp;|&nbsp; 📋 ${esc(a.class_name)}${a.section_name ? ' - ' + esc(a.section_name) : ''}
                </div>
                ${a.description ? `<p style="margin:8px 0 0; font-size:0.85rem; color:var(--text-secondary); white-space:pre-line;">${esc(a.description)}</p>` : ''}
                <div style="margin-top:8px; font-size:0.8rem; color:var(--text-muted);">
                  📅 Due: <strong style="color:${isOverdue ? 'var(--danger)' : 'var(--text-primary)'}">${due}</strong> &nbsp;|&nbsp; Created: ${created}
                </div>
              </div>
              <div style="display:flex; gap:6px;">
                <button class="btn btn-sm" style="background:var(--primary); font-size:0.75rem;" onclick="editAssignment(${a.id})">Edit</button>
                <button class="btn btn-sm" style="background:var(--danger); font-size:0.75rem;" onclick="deleteAssignment(${a.id})">Delete</button>
              </div>
            </div>
          </div>`;
      }).join('');
    } catch (err) {
      container.innerHTML = `<p style="color:var(--danger);">Error loading assignments: ${err.message}</p>`;
    }
  }

  async function loadAssignmentForm() {
    try {
      const data = await apiCall('/api/teachers/my-subjects');
      const allEntries = data.allEntries || [];
      const subjects = [...new Set(allEntries.map(e => e.subject))];
      const classes = [...new Set(allEntries.map(e => e.class_name))];
      const sections = [...new Set(allEntries.map(e => e.section_name))];

      cachedTimetableClasses = allEntries;

      const subjectSel = document.getElementById('assignment-subject');
      subjectSel.innerHTML = '<option value="">Select subject...</option>' + subjects.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');

      const classSel = document.getElementById('assignment-class');
      classSel.innerHTML = '<option value="">Select class...</option>' + classes.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');

      classSel.addEventListener('change', () => {
        const selectedClass = classSel.value;
        const filteredSections = [...new Set(allEntries.filter(e => e.class_name === selectedClass).map(e => e.section_name))];
        const sectionSel = document.getElementById('assignment-section');
        sectionSel.innerHTML = '<option value="">All Sections</option>' + filteredSections.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      });

      classSel.dispatchEvent(new Event('change'));
    } catch (err) {
      console.error('Error loading assignment form data:', err);
    }
  }

  document.getElementById('btn-new-assignment').addEventListener('click', async () => {
    document.getElementById('assignment-form-card').style.display = 'block';
    document.getElementById('assignment-form-title').textContent = 'New Assignment';
    document.getElementById('form-assignment').reset();
    document.getElementById('assignment-edit-id').value = '';
    await loadAssignmentForm();
    document.getElementById('assignment-form-card').scrollIntoView({ behavior: 'smooth' });
  });

  document.getElementById('btn-cancel-assignment').addEventListener('click', () => {
    document.getElementById('assignment-form-card').style.display = 'none';
  });

  document.getElementById('form-assignment').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('assignment-edit-id').value;
    const payload = {
      title: document.getElementById('assignment-title').value.trim(),
      type: document.getElementById('assignment-type').value,
      subject: document.getElementById('assignment-subject').value,
      class_name: document.getElementById('assignment-class').value,
      section_name: document.getElementById('assignment-section').value,
      due_date: document.getElementById('assignment-due-date').value,
      priority: document.getElementById('assignment-priority').value,
      description: document.getElementById('assignment-description').value.trim()
    };

    if (!payload.title || !payload.subject || !payload.class_name) {
      showToast('Please fill in title, subject, and class', true);
      return;
    }

    try {
      if (editId) {
        await apiCall('/api/teachers/assignments/' + editId, 'PUT', payload);
        showToast('Assignment updated successfully!');
      } else {
        await apiCall('/api/teachers/assignments', 'POST', payload);
        showToast('Assignment created successfully!');
      }
      document.getElementById('assignment-form-card').style.display = 'none';
      loadAssignments();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  });

  window.editAssignment = async function(id) {
    const a = cachedAssignments.find(x => x.id === id);
    if (!a) return;

    await loadAssignmentForm();

    document.getElementById('assignment-form-card').style.display = 'block';
    document.getElementById('assignment-form-title').textContent = 'Edit Assignment';
    document.getElementById('assignment-edit-id').value = a.id;
    document.getElementById('assignment-title').value = a.title;
    document.getElementById('assignment-type').value = a.type;
    document.getElementById('assignment-subject').value = a.subject;
    document.getElementById('assignment-class').value = a.class_name;
    document.getElementById('assignment-due-date').value = a.due_date || '';
    document.getElementById('assignment-priority').value = a.priority || 'medium';
    document.getElementById('assignment-description').value = a.description || '';

    // Trigger section population
    setTimeout(() => {
      document.getElementById('assignment-class').dispatchEvent(new Event('change'));
      setTimeout(() => { document.getElementById('assignment-section').value = a.section_name || ''; }, 100);
    }, 100);

    document.getElementById('assignment-form-card').scrollIntoView({ behavior: 'smooth' });
  };

  window.deleteAssignment = async function(id) {
    if (!confirm('Delete this assignment? This cannot be undone.')) return;
    try {
      await apiCall('/api/teachers/assignments/' + id, 'DELETE');
      showToast('Assignment deleted');
      loadAssignments();
    } catch (err) {
      showToast('Error: ' + err.message, true);
    }
  };

  // Load assignments when nav clicked
  document.querySelector('[data-opt="assignments"]').addEventListener('click', () => {
    loadAssignments();
  });

  // Dashboard assignments summary
  async function loadDashboardAssignments() {
    const container = document.getElementById('dashboard-assignments-container');
    if (!container) return;
    try {
      const assignments = await apiCall('/api/teachers/assignments');
      if (assignments.length === 0) {
        container.innerHTML = `<div style="text-align:center; padding:30px 20px; background:rgba(255,255,255,0.02); border-radius:16px; border:1px dashed var(--border-glow);"><div style="font-size:2.5rem; margin-bottom:10px;">📚</div><p style="color:var(--text-muted);">No assignments created yet.</p><p style="color:var(--text-muted); font-size:0.85rem;">Click "Assignments" in the sidebar to create your first assignment.</p></div>`;
        return;
      }
      const typeLabels = { homework: 'Homework', monthly_test: 'Monthly Test', class_test: 'Class Test', quiz: 'Quiz', project: 'Project', other: 'Other' };
      const typeColors = { homework: '#6366f1', monthly_test: '#f59e0b', class_test: '#ef4444', quiz: '#10b981', project: '#8b5cf6', other: '#64748b' };
      const recent = assignments.slice(0, 3);
      container.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px;">` +
        recent.map(a => {
          const due = a.due_date ? new Date(a.due_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
          const isOverdue = a.due_date && new Date(a.due_date) < new Date();
          return `<div class="card" style="border-left:4px solid ${typeColors[a.type] || '#6366f1'}; cursor:pointer;" onclick="document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active')); document.querySelector('[data-opt=assignments]').classList.add('active'); document.querySelectorAll('.content-panel').forEach(p=>p.classList.remove('active')); document.getElementById('panel-assignments').classList.add('active'); loadAssignments();">
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px;"><span style="background:${typeColors[a.type]}; color:#fff; padding:1px 8px; border-radius:12px; font-size:0.7rem;">${typeLabels[a.type]}</span>${isOverdue ? '<span style="color:#ef4444; font-size:0.7rem;">OVERDUE</span>' : ''}</div>
            <h4 style="margin:0; font-size:0.95rem;">${esc(a.title)}</h4>
            <div style="font-size:0.8rem; color:var(--text-muted);">${esc(a.subject)} · ${esc(a.class_name)}${a.section_name ? ' - ' + esc(a.section_name) : ''} ${due ? '· Due ' + due : ''}</div>
          </div>`;
        }).join('') + `</div>`;
    } catch (err) {}
  }

  // ==================== INIT ====================
  loadMySubjects();
  loadMarksFilters();
  loadAnnouncements();
  loadDashboardAssignments();
});
