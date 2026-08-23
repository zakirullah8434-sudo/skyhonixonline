# SkyHonix Master Admin Panel - Complete Guide

## Overview
A new **Master Admin Management Panel** has been added to SkyHonix that allows you to authenticate and manage all registered schools from a centralized dashboard.

---

## 🎯 What's New

### 1. **Admin Panel URL**
- **Access at:** `http://localhost:3000/admin.html`
- **Link also available** in the main navigation bar (top-right corner with 🔐 icon)

### 2. **Authentication Requirements**
To access the admin panel, you need:
- **School Email** - The email address the school registered with
- **School Unique Code** - Generated automatically during registration (format: `skyhonix[phone-number]`)
- **Master Password** - `goldensunbk` (hardcoded for security - should be moved to environment variables in production)

---

## 📋 How to Use

### Step 1: Access the Admin Panel
1. Go to `http://localhost:3000/admin.html`
2. You'll see the login screen with three fields

### Step 2: Enter Credentials
```
School Email:      [the email used when registering the school]
School Code:       [the unique code shown after registration - e.g., skyhonix03001234567]
Master Password:   goldensunbk
```

### Step 3: Login
Click **"Login to Admin Panel"** button

---

## 🎛️ Admin Dashboard Features

Once logged in, you'll see the admin dashboard with the following options in the left sidebar:

### 1. **📊 All Schools**
- View all registered schools in one table
- See: School name, email, code, status, creation date
- Quick actions for each school (View, Approve, Suspend)

### 2. **⏳ Pending Approval** 
- Shows only schools with "suspended" status (not yet approved)
- These are new registrations waiting for admin activation
- Click **"Approve"** to activate and change status to "active"

### 3. **✅ Active Schools**
- Shows only schools with "active" status
- These schools can fully use the system
- Option to suspend if needed

### 4. **🔒 Suspended**
- Shows suspended schools
- Can be re-activated by approving them

### 5. **📈 Statistics**
- Quick overview dashboard showing:
  - Total number of schools
  - Number pending approval
  - Number of active schools
  - Number of suspended schools

---

## 🎯 School Management Actions

### Approve a School (Allow/Activate)
1. Go to **"Pending Approval"** tab, or find the school in **"All Schools"**
2. Click the **"✅ Approve"** button on the school row
3. Or click **"View"** to see full details, then click **"✅ Approve & Activate"**
4. Confirm the action
5. School status changes from "suspended" → "active"
6. A 30-day subscription period is automatically set

### View School Details
1. Click the **"View"** button on any school row
2. A modal popup shows:
   - School name, email, phone
   - Unique school code
   - Current subscription status
   - Subscription amount (PKR)
   - Creation date
   - Next due date (if active)
3. From this popup you can also approve or suspend

### Suspend a School
1. Click **"Suspend"** button on an active school row
2. Or open the school details and click **"🔒 Suspend"**
3. Confirm the action
4. School status changes to "suspended"
5. School admin can no longer access portal (except billing section)

---

## 📊 School Status Meanings

| Status | Meaning | Can Access Portal? |
|--------|---------|-------------------|
| **suspended** | Not yet approved or subscription expired | ❌ No (except billing) |
| **active** | Approved and subscription is valid | ✅ Yes |
| **trial** | Trial period (future use) | ✅ Yes |

---

## 🔧 Backend API Endpoints

The admin panel uses these REST API endpoints (all require admin authentication):

### Authentication
```
POST /api/admin/authenticate
Body: { email, code, password }
Returns: JWT token
```

### Schools Management
```
GET  /api/admin/schools              - List all schools
GET  /api/admin/schools?status=active - Filter by status
GET  /api/admin/schools/:id          - Get school details
POST /api/admin/schools/:id/approve  - Approve & activate school
POST /api/admin/schools/:id/suspend  - Suspend school
POST /api/admin/schools/:id/update-amount - Change subscription amount
```

### Statistics
```
GET  /api/admin/statistics - Get dashboard statistics
```

---

## 📁 Files Added/Modified

### New Files Created
1. **`public/admin.html`** (23.5 KB)
   - Complete admin panel UI with login form and dashboard
   - Responsive design with glassmorphism styling
   - School management tables and modals

2. **`routes/admin.js`** (7.7 KB)
   - Backend API routes for admin functions
   - Authentication middleware
   - School approval/suspension logic
   - Statistics endpoints

### Files Modified
1. **`server.js`**
   - Added import for admin routes
   - Mounted `/api/admin` endpoint

2. **`public/index.html`**
   - Added "🔐 Admin" link in navigation bar

---

## 🔒 Security Notes

### Current Implementation
- Master password hardcoded as `goldensunbk`
- Admin token uses same JWT secret as school tokens
- Token expires in 24 hours

### Recommendations for Production
1. **Move master password to environment variable:**
   ```javascript
   const MASTER_PASSWORD = process.env.ADMIN_PASSWORD || 'goldensunbk';
   ```

2. **Use separate JWT secret for admin tokens:**
   ```javascript
   const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET;
   const adminToken = jwt.sign(payload, ADMIN_JWT_SECRET, { expiresIn: '24h' });
   ```

3. **Add audit logging:**
   - Log all admin actions (approvals, suspensions, etc.)
   - Track who made changes and when

4. **Add rate limiting:**
   - Prevent brute force attacks on admin login
   - Use packages like `express-rate-limit`

---

## 🧪 Testing the Admin Panel

### Scenario: Register and Approve a School

1. **Register a school:**
   - Go to `http://localhost:3000`
   - Click "Register School"
   - Fill in: School Name, Email, Password, Phone
   - Note the returned "Unique Code"

2. **Check school status:**
   - Go to admin panel: `http://localhost:3000/admin.html`
   - Login with:
     - Email: [the email from step 1]
     - Code: [the code from step 1]
     - Password: `goldensunbk`

3. **See pending school:**
   - Go to "⏳ Pending Approval" tab
   - You should see the newly registered school

4. **Approve the school:**
   - Click "✅ Approve" button
   - Confirm the action
   - Status changes to "active"

5. **School can now login:**
   - Go to `http://localhost:3000/portal.html`
   - School admin can now access their dashboard

---

## 🆘 Troubleshooting

### "Invalid master password"
- Check that you're entering exactly: `goldensunbk`
- Make sure Caps Lock is off

### "School not found with provided email and code"
- Verify the email matches exactly (case-sensitive)
- Verify the code is correct (usually format: `skyhonix` + phone number)
- School must be registered in the system first

### Can't see any schools
- Make sure at least one school has been registered
- Check the "All Schools" tab first, then filter by status

### School can't login after approval
- Verify school status is "active" in admin panel
- School admin might need to clear browser cache/cookies
- Try logging out and back in

---

## 📞 Example Usage Flow

```
1. School Registration (portal)
   → School fills registration form
   → Gets unique code (e.g., skyhonix03459191224)
   → Status set to "suspended" (pending approval)

2. Admin Review (admin panel)
   → Admin logs in with: email + code + master password
   → Views pending schools
   → Clicks "Approve"
   → Status changes to "active"
   → Next due date set to 30 days from now

3. School Access (portal)
   → School admin can now log in
   → Full access to students, fees, attendance, exams
   → Can submit payment slips if subscription expires
```

---

## 🚀 Next Steps (Optional Enhancements)

1. **Add admin users table** - Multiple admins with different roles
2. **Add audit logging** - Track all admin actions
3. **Add email notifications** - Notify schools when approved
4. **Bulk actions** - Approve/suspend multiple schools at once
5. **Advanced filtering** - Filter by date range, amount, etc.
6. **Export reports** - Export school data to CSV/PDF
7. **Two-factor authentication** - For admin login security

---

## 📚 Related Files
- `CLAUDE.md` - Project overview and setup
- `server.js` - Main Express server
- `routes/auth.js` - School authentication
- `main_db_init.js` - Database schema
