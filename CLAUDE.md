# CLAUDE.md - SkyHonix School System (Online Multi-Tenant Platform)

## Project Overview

**SkyHonix School System (Online)** is a responsive, multi-tenant web-based school management platform built with Node.js, Express, and SQLite. It replaces the legacy PyQt5 desktop application and features automatic schema initialization for each school tenant, subscription billing, automatic/manual backups, student registration, exams/results management, and an administration dashboard.

### Key Characteristics
- **Type:** Web Application (Single-Page Application frontend + REST API backend)
- **Backend:** Node.js, Express, SQLite (`sqlite3`)
- **Frontend:** HTML, Vanilla CSS (Glassmorphism), Vanilla Javascript
- **Multi-Tenancy:** Each registered school has its own SQLite database file dynamically managed and initialized.
- **Billing Model:** Trial & subscription-based billing (1500 PKR/month) with master approval controls.

---

## Development Setup

### Prerequisites
- **Node.js:** Version 24+ recommended

### Quick Start
```bash
# 1. Install dependencies
npm install

# 2. Run the application (starts both backend server and hosts frontend)
npm start
```

### Local Access Links
Once running, open these links in your browser:
- **Public Landing & Register Portal:** http://localhost:3000/
- **School Administration Workspace:** http://localhost:3000/portal.html

---

## Project Structure
- `server.js` - Express API server entry point.
- `config.js` - Server configuration and upload path alignments.
- `database_manager.js` - Dynamic SQLite connection registry manager (multi-tenant layout).
- `school_db_template.js` - SQLite database initialization schema for tenant school databases.
- `main_db_init.js` - Initializes the global tenancy and billing database (`main.db`).
- `public/` - Static assets and frontend SPA pages.
  - `index.html` - Public landing portal.
  - `portal.html` - Workspace administration panel (students, attendance, fees, marks, exams).
  - `js/app.js` - Front-end JavaScript logic and API fetchers.
  - `css/styles.css` - Custom glassmorphic styles.
- `routes/` - Express API backend routes.
  - `auth.js` - School registration & authentication.
  - `students.js` - Student records management.
  - `attendance.js` - QR-based & manual attendance tracking.
  - `fees.js` - Fee ledger & payments tracking.
  - `exams.js` - Exams management and marksheet/DMC generator.
  - `billing.js` - Tenant subscription invoice & receipt validation.
  - `settings.js` - Backups & general tenant settings.
