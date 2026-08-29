// Teacher Portal - SkyHonix School System

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
  async function loadNewsTicker() {
    try {
      const announcements = await apiCall('/api/teachers/announcements');
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
    } catch (e) {}
  }
  loadNewsTicker();

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
            <input type="number" min="0" max="100" class="form-control" style="width:100px; margin:0 auto; text-align:center;"
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

  document.getElementById('btn-save-marks').addEventListener('click', async () => {
    const examId = document.getElementById('marks-exam-select').value;
    const term = document.getElementById('marks-term-select').value;
    const className = document.getElementById('marks-class-select').value;
    const subject = document.getElementById('marks-subject-select').value;

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

  // ==================== INIT ====================
  loadMySubjects();
  loadMarksFilters();
  loadAnnouncements();
});
