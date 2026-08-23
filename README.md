# SkyHonix School Management System (Online Version)

This is the online, responsive, multi-tenant web-based version of the SkyHonix School Management System. It replaces the legacy PyQt5 desktop application.

## Project Structure

- `server.js` - Express API server entry point.
- `config.js` - Server configuration and upload path alignments.
- `database_manager.js` - Dynamic SQLite connection registry manager (multi-tenant layout).
- `school_db_template.js` - SQLite database initialization schema.
- `main_db_init.js` - Initializes the global tenancy and billing database `main.db`.
- `public/` - Static assets and frontend SPA pages.
  - `index.html` - Premium responsive landing page.
  - `portal.html` - Workspace administration panel (students, attendance, carry-forward fees, marks sheets, results generator, DMCs).
  - `js/app.js` - Front-end JavaScript logic, API fetchers, and QR camera scanner integrations.
  - `css/styles.css` - Custom glassmorphic styles.

## Direct Launchers

- [index_frontend.html](index_frontend.html) - Open in browser to launch the landing page.
- [index_backend.html](index_backend.html) - Open in browser to launch the school workspace.

## Local Development Setup

1. Make sure Node.js (version 24 or newer) is installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Launch local server:
   ```bash
   npm start
   ```
4. Access portals in browser:
   - Portal landing: `http://localhost:3000/`
   - Workspace login: `http://localhost:3000/portal.html`

## Hosting Online

You can host this project on Render, Railway, Heroku, or a VPS:
- Point start command to: `node server.js`
- Set port to: `3000` (or configure via `PORT` environment variable)
- Mount a persistent disk volume to `public/databases/` to ensure SQLite database files persist across deployments.

## Subscription Billing Model (1500 PKR monthly)

- If a school's trial or billing expires, their portal locks and displays bank details (EasyPaisa/JazzCash/HBL) to upload receipt screenshots.
- Master administration panel can be accessed on the billing page using master PIN: `goldensunbk` to verify, approve, or reject school invoices and payment slips.
