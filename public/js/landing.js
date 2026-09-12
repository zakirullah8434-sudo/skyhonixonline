// Landing page interactivity and API integration

document.addEventListener('DOMContentLoaded', () => {
  // Mobile nav hamburger
  const navHamburger = document.getElementById('nav-hamburger');
  const navLinks = document.getElementById('nav-links');
  if (navHamburger && navLinks) {
    navHamburger.addEventListener('click', () => {
      navLinks.classList.toggle('open');
    });
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => navLinks.classList.remove('open'));
    });
  }

  // Elements
  const btnLoginTrigger = document.getElementById('btn-login-trigger');
  const btnSignupTrigger = document.getElementById('btn-signup-trigger');
  const btnGetStarted = document.getElementById('btn-get-started');
  const btnPricingTrial = document.getElementById('btn-pricing-trial');
  
  const drawerLogin = document.getElementById('drawer-login');
  const drawerSignup = document.getElementById('drawer-signup');
  
  const btnLoginClose = document.getElementById('btn-login-close');
  const btnSignupClose = document.getElementById('btn-signup-close');
  
  const formLogin = document.getElementById('form-login');
  const formLoginTeacher = document.getElementById('form-login-teacher');
  const formLoginParent = document.getElementById('form-login-parent');
  const formSignup = document.getElementById('form-signup');
  
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toast-text');

  // Role toggle buttons
  const roleSchoolBtn = document.getElementById('login-role-school');
  const roleTeacherBtn = document.getElementById('login-role-teacher');
  const roleParentBtn = document.getElementById('login-role-parent');
  const loginTitle = document.getElementById('login-drawer-title');

  // Show toast notification helper
  function showToast(message, isError = false) {
    toastText.innerText = message;
    if (isError) {
      toast.style.background = '#DC2626';
      toast.style.borderColor = '#FCA5A5';
    } else {
      toast.style.background = '#1F2937';
      toast.style.borderColor = 'var(--primary)';
    }
    toast.style.color = '#F9FAFB';
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 4000);
  }

  // Role toggle logic
  function setLoginRole(role) {
    [roleSchoolBtn, roleTeacherBtn, roleParentBtn].forEach(b => { b.classList.remove('btn-primary'); b.classList.add('btn-outline'); });
    formLogin.style.display = 'none';
    formLoginTeacher.style.display = 'none';
    formLoginParent.style.display = 'none';
    if (role === 'school') {
      roleSchoolBtn.classList.remove('btn-outline');
      roleSchoolBtn.classList.add('btn-primary');
      formLogin.style.display = 'block';
      loginTitle.textContent = 'School Staff Login';
    } else if (role === 'teacher') {
      roleTeacherBtn.classList.remove('btn-outline');
      roleTeacherBtn.classList.add('btn-primary');
      formLoginTeacher.style.display = 'block';
      loginTitle.textContent = 'Teacher Login';
    } else {
      roleParentBtn.classList.remove('btn-outline');
      roleParentBtn.classList.add('btn-primary');
      formLoginParent.style.display = 'block';
      loginTitle.textContent = 'Parent Login';
    }
  }

  roleSchoolBtn.addEventListener('click', () => setLoginRole('school'));
  roleTeacherBtn.addEventListener('click', () => setLoginRole('teacher'));
  roleParentBtn.addEventListener('click', () => setLoginRole('parent'));

  // Drawers open/close
  btnLoginTrigger.addEventListener('click', () => {
    drawerSignup.classList.remove('open');
    drawerLogin.classList.add('open');
    if (window.innerWidth <= 768) document.body.classList.add('drawer-open');
  });

  btnSignupTrigger.addEventListener('click', () => {
    drawerLogin.classList.remove('open');
    drawerSignup.classList.add('open');
    if (window.innerWidth <= 768) document.body.classList.add('drawer-open');
  });

  btnLoginClose.addEventListener('click', () => {
    drawerLogin.classList.remove('open');
    document.body.classList.remove('drawer-open');
  });
  btnSignupClose.addEventListener('click', () => {
    drawerSignup.classList.remove('open');
    document.body.classList.remove('drawer-open');
  });

  // Hero Actions scroll
  btnGetStarted.addEventListener('click', () => {
    drawerLogin.classList.remove('open');
    drawerSignup.classList.add('open');
    if (window.innerWidth <= 768) document.body.classList.add('drawer-open');
  });

  if (btnPricingTrial) {
    btnPricingTrial.addEventListener('click', () => {
      drawerLogin.classList.remove('open');
      drawerSignup.classList.add('open');
      if (window.innerWidth <= 768) document.body.classList.add('drawer-open');
    });
  }

  // API Call: Register School tenant
  formSignup.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('signup-error-msg');
    const successMsg = document.getElementById('signup-success-msg');
    
    errorMsg.style.display = 'none';
    successMsg.style.display = 'none';

    const schoolName = document.getElementById('signup-school-name').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;
    const selectedPackage = document.getElementById('signup-package').value;

    if (!selectedPackage) {
      errorMsg.innerText = 'Please select a package before registering.';
      errorMsg.style.display = 'block';
      return;
    }

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolName, email, password, phone, selectedPackage })
      });

      let result;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        result = await response.json();
      } else {
        const text = await response.text();
        throw new Error(text.includes('The page') ? 'Server is restarting. Please try again in a few seconds.' : (text || 'Server returned an unexpected response. Please try again.'));
      }

      if (!response.ok) {
        throw new Error(result.error || 'Failed to register school');
      }

      successMsg.innerHTML = result.message;
      successMsg.style.display = 'block';
      formSignup.reset();
      showToast('Registration successful! School code generated.');

      // Wait 1.5s then slide into login drawer
      setTimeout(() => {
        drawerSignup.classList.remove('open');
        drawerLogin.classList.add('open');
        // Fill school email automatically for convenience
        document.getElementById('login-school-email').value = email;
        if (window.innerWidth <= 768) document.body.classList.add('drawer-open');
      }, 1500);

    } catch (err) {
      errorMsg.innerText = err.message;
      errorMsg.style.display = 'block';
    }
  });

  // API Call: School Login
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('login-error-msg');
    errorMsg.style.display = 'none';

    const schoolEmail = document.getElementById('login-school-email').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolEmail, password })
      });

      let result;
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        result = await response.json();
      } else {
        const text = await response.text();
        throw new Error(text.includes('The page') ? 'Server is restarting. Please try again in a few seconds.' : (text || 'Server returned an unexpected response.'));
      }

      if (!response.ok) {
        throw new Error(result.error || 'Login failed');
      }

      // Save token & session variables
      localStorage.setItem('skyhonix_token', result.token);
      localStorage.setItem('skyhonix_user', JSON.stringify(result.user));

      showToast('Access granted! Entering workspace...');

      setTimeout(() => {
        window.location.href = 'portal.html';
      }, 1000);

    } catch (err) {
      errorMsg.innerText = err.message;
      errorMsg.style.display = 'block';
      // Scroll error into view on mobile
      errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // API Call: Teacher Login
  formLoginTeacher.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('login-teacher-error-msg');
    errorMsg.style.display = 'none';

    const schoolId = document.getElementById('login-teacher-school-id').value.trim();
    const phone = document.getElementById('login-teacher-phone').value.trim();
    const password = document.getElementById('login-teacher-password').value;

    try {
      const response = await fetch('/api/auth/teacher-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ school_id: parseInt(schoolId), phone, password })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Login failed');
      }

      // Save token & session variables
      localStorage.setItem('skyhonix_token', result.token);
      localStorage.setItem('skyhonix_user', JSON.stringify(result.user));

      showToast('Welcome, ' + result.user.teacherName + '! Entering portal...');

      setTimeout(() => {
        window.location.href = 'teacher-portal.html';
      }, 1000);

    } catch (err) {
      errorMsg.innerText = err.message;
      errorMsg.style.display = 'block';
      errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // API Call: Parent Login
  formLoginParent.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorMsg = document.getElementById('login-parent-error-msg');
    errorMsg.style.display = 'none';

    const schoolId = document.getElementById('login-parent-school-id').value.trim();
    const phone = document.getElementById('login-parent-phone').value.trim();
    const password = document.getElementById('login-parent-password').value;

    try {
      const response = await fetch('/api/parents/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ school_id: parseInt(schoolId), phone, password })
      });

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Login failed');
      }

      localStorage.setItem('skyhonix_token', result.token);
      localStorage.setItem('skyhonix_user', JSON.stringify(result.user));

      showToast('Welcome, ' + result.user.parentName + '! Entering portal...');

      setTimeout(() => {
        window.location.href = 'parent-portal.html';
      }, 1000);

    } catch (err) {
      errorMsg.innerText = err.message;
      errorMsg.style.display = 'block';
      errorMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // Social Login Handler
  window.socialLogin = function(provider, userType) {
    const schoolId = userType === 'teacher' || userType === 'parent' 
      ? document.getElementById(`login-${userType}-school-id`)?.value || ''
      : '';
    
    const params = new URLSearchParams({
      type: userType,
      school_id: schoolId
    });
    
    window.location.href = `/api/auth/${provider}?${params.toString()}`;
  };

  // Handle OAuth callback
  const urlParams = new URLSearchParams(window.location.search);
  
  if (urlParams.get('social_login') === 'success') {
    const token = urlParams.get('token');
    const user = JSON.parse(decodeURIComponent(urlParams.get('user') || '{}'));
    const type = urlParams.get('type');
    
    if (token) {
      localStorage.setItem('skyhonix_token', token);
      localStorage.setItem('skyhonix_user', JSON.stringify(user));
      
      showToast('Login successful! Redirecting...');
      
      setTimeout(() => {
        if (type === 'school') {
          window.location.href = 'portal.html';
        } else if (type === 'teacher') {
          window.location.href = 'teacher-portal.html';
        } else if (type === 'parent') {
          window.location.href = 'parent-portal.html';
        } else if (type === 'admin') {
          window.location.href = 'admin.html';
        } else {
          window.location.href = 'portal.html';
        }
      }, 1000);
    }
  }
  
  if (urlParams.get('social_register') === 'true') {
    // Show social registration modal
    const modal = document.getElementById('social-register-modal');
    modal.style.display = 'flex';
    
    document.getElementById('social-temp-id').value = urlParams.get('temp_id') || '';
    document.getElementById('social-provider').value = urlParams.get('provider') || '';
    document.getElementById('social-user-type').value = urlParams.get('type') || 'school';
    document.getElementById('social-email').value = urlParams.get('email') || '';
    document.getElementById('social-email-hidden').value = urlParams.get('email') || '';
    document.getElementById('social-name').value = urlParams.get('name') || '';
    document.getElementById('social-name-hidden').value = urlParams.get('name') || '';
    
    const userType = urlParams.get('type');
    const schoolIdGroup = document.getElementById('social-school-id-group');
    const teacherFields = document.getElementById('social-teacher-fields');
    const parentFields = document.getElementById('social-parent-fields');
    
    if (userType === 'teacher' || userType === 'parent') {
      schoolIdGroup.style.display = 'block';
      document.getElementById('social-school-id').value = urlParams.get('school_id') || '';
      
      if (userType === 'teacher') {
        teacherFields.style.display = 'block';
      } else if (userType === 'parent') {
        parentFields.style.display = 'block';
      }
    }
  }

  // Social Registration Form Handler
  const socialRegisterForm = document.getElementById('social-register-form');
  if (socialRegisterForm) {
    socialRegisterForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const errorMsg = document.getElementById('social-register-error');
      errorMsg.style.display = 'none';
      
      const tempId = document.getElementById('social-temp-id').value;
      const phone = document.getElementById('social-phone').value.trim();
      const name = document.getElementById('social-name').value.trim();
      const schoolId = document.getElementById('social-school-id')?.value || null;
      const subject = document.getElementById('social-subject')?.value || null;
      const qualification = document.getElementById('social-qualification')?.value || null;
      const cnic = document.getElementById('social-cnic')?.value || null;
      const address = document.getElementById('social-address')?.value || null;
      
      if (!phone) {
        errorMsg.innerText = 'Mobile number is required';
        errorMsg.style.display = 'block';
        return;
      }
      
      if (phone.length < 11) {
        errorMsg.innerText = 'Please enter a valid 11-digit mobile number';
        errorMsg.style.display = 'block';
        return;
      }
      
      try {
        const response = await fetch('/api/auth/complete-registration', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            temp_id: tempId,
            phone,
            name,
            school_id: schoolId,
            subject,
            qualification,
            cnic,
            address
          })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
          throw new Error(result.error || 'Failed to complete registration');
        }
        
        showToast(result.message);
        
        // Close modal and show success
        document.getElementById('social-register-modal').style.display = 'none';
        
        // Show pending approval message
        const modal = document.getElementById('social-register-modal');
        modal.innerHTML = `
          <div style="background: white; border-radius: 16px; padding: 32px; max-width: 450px; width: 90%; text-align: center;">
            <div style="width: 60px; height: 60px; background: #ECFDF5; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 16px;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
            </div>
            <h3 style="margin: 0 0 8px; color: #111827;">Registration Submitted!</h3>
            <p style="color: #6B7280; font-size: 14px; margin: 0 0 16px;">${result.message}</p>
            <button onclick="document.getElementById('social-register-modal').style.display='none'" class="btn btn-primary" style="width: 100%;">Close</button>
          </div>
        `;
        
      } catch (err) {
        errorMsg.innerText = err.message;
        errorMsg.style.display = 'block';
      }
    });
  }

  // Close social register modal
  window.closeSocialRegisterModal = function() {
    document.getElementById('social-register-modal').style.display = 'none';
  };

  // Handle error from OAuth
  if (urlParams.get('error')) {
    const error = urlParams.get('error');
    let message = 'Authentication failed. Please try again.';
    
    if (error === 'google_auth_failed') {
      message = 'Google authentication failed. Please try again.';
    } else if (error === 'apple_auth_failed') {
      message = 'Apple authentication failed. Please try again.';
    }
    
    showToast(message, true);
  }
});
