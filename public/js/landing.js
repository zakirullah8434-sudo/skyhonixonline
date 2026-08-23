// Landing page interactivity and API integration

document.addEventListener('DOMContentLoaded', () => {
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
  const formSignup = document.getElementById('form-signup');
  
  const toast = document.getElementById('toast');
  const toastText = document.getElementById('toast-text');

  // Show toast notification helper
  function showToast(message, isError = false) {
    toastText.innerText = message;
    toast.style.borderColor = isError ? 'var(--danger)' : 'var(--primary)';
    toast.style.display = 'block';
    setTimeout(() => {
      toast.style.display = 'none';
    }, 4000);
  }

  // Drawers open/close
  btnLoginTrigger.addEventListener('click', () => {
    drawerSignup.classList.remove('open');
    drawerLogin.classList.add('open');
  });

  btnSignupTrigger.addEventListener('click', () => {
    drawerLogin.classList.remove('open');
    drawerSignup.classList.add('open');
  });

  btnLoginClose.addEventListener('click', () => drawerLogin.classList.remove('open'));
  btnSignupClose.addEventListener('click', () => drawerSignup.classList.remove('open'));

  // Hero Actions scroll
  btnGetStarted.addEventListener('click', () => {
    drawerLogin.classList.remove('open');
    drawerSignup.classList.add('open');
  });

  btnPricingTrial.addEventListener('click', () => {
    drawerLogin.classList.remove('open');
    drawerSignup.classList.add('open');
  });

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

    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolName, email, password, phone })
      });

      const result = await response.json();

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

    const schoolEmail = document.getElementById('login-school-email').value.trim();
    const password = document.getElementById('login-password').value;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schoolEmail, password })
      });

      const result = await response.json();

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
    }
  });
});
