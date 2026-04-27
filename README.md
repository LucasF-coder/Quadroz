# Quadroz ⚡

Quadroz is a high-performance, modern platform for reading manga and comics. It is designed to provide a fluid, organized experience with native integration into the Suwayomi/Mihon ecosystem.

## 🚀 Key Features

- **Modular Architecture:** Frontend built with a clear structure of components, hooks, services, and views.
- **Extreme Performance:** Lazy loading with placeholder blur effect and intelligent preloading.
- **Suwayomi Integration:** Automatic synchronization with Suwayomi repositories.
- **Library Management:** Advanced filters by genre, language, status, and categories.
- **Robust Security:** JWT-based authentication and secure password hashing.

## 🛠️ Tech Stack

- **Backend:** Node.js, Express.
- **Database:** SQLite (better-sqlite3).
- **Frontend:** Vanilla JavaScript (ES6+), modern CSS3, SPA.

## ⚙️ Installation and Setup

### Prerequisites
- Node.js (v18+)
- Suwayomi Server

### Step-by-Step

1. **Clone the Repository:**
   ```bash
   git clone https://github.com/LucasF-coder/Quadroz.git
   cd Quadroz
   ```

2. **Install Dependencies:**
   ```bash
   npm install
   ```

3. **Environment Configuration:**
   Create a `.env` file based on `.env.example`.

4. **Build:**
   ```bash
   npm run build
   ```

5. **Start:**
   ```bash
   npm start
   ```

## 📜 Available Scripts

| Command | Description |
| :--- | :--- |
| `npm start` | Starts the server. |
| `npm run dev` | Development mode with watch. |
| `npm run build` | Generates optimized production files. |
| `npm run pm2:start` | Runs with PM2. |
| `npm run sync:mihon` | Syncs metadata. |
| `npm run seed` | Initializes default database. |

## 📁 Directory Structure

- `/public`: Frontend source.
- `/server`: Server logic and API.
- `/scripts`: Automation and build scripts.
- `/dist`: Production build.
- `/deploy`: Infrastructure configs.

## 📄 License

This project is licensed under the **ISC** license.
