# SmartGate Web App

The SmartGate dashboard. The backend is **Node.js** ([Fastify](https://fastify.dev/)) with
[Socket.IO](https://socket.io/) for live updates and PostgreSQL for data. The frontend is plain
HTML, CSS and JavaScript. Everything runs in Docker Compose, on a PC or on the Jetson Orin Nano (ARM64).

This guide walks you through building the Docker images required to run the SmartGate web app using Docker Compose.

## Prerequisites

- Docker installed on your machine. Follow the [Official Docker Installation Guide](https://docs.docker.com/get-docker/) if you haven't already.
-  Docker Compose installed (usually included with Docker Desktop or available separately). Follow the [Docker Compose Install Guide](https://docs.docker.com/compose/install/) if you can't access docker-compose.
- Access to a terminal (Linux/macOS) or a terminal emulator like Git Bash (Windows).
-  Git installed. You can download it from [Git Install Guides](https://github.com/git-guides/install-git)
-  Internet Access is required to download the images from Docker Hub (written in `docker-compose.yml` file).

## Steps

### 1. Clone the Repository

First, clone the SmartGate repository to your local machine.

```sh
git clone https://github.com/ChristopherLaff/SmartGate.git
cd SmartGate
```

### 2. Navigate to `src/web-app` directory
Once you're in the `SmartGate` directory, navigate to the `src/web-app` directory.

```sh
cd src/web-app
```

### 3. Create your settings file
Copy `.env.example` to `.env` and fill it in. Each setting is explained in the file.
`.env` holds secrets, so it is ignored by git and must never be committed.

```sh
cp .env.example .env
```

At minimum, set `SESSION_SECRET`. Set `ADMIN_USERS` to your GitHub username so you can control gates.
The app also runs with an empty `.env`; it then logs everyone out on each restart and has no admins.

### 4. Build the docker images
Now, to run the SmartGate Web App, you need to build the images using the docker-compose file in the current directory.

```sh
docker-compose up --build -d
```

Then open `http://localhost:8000` (or `http://<device-ip>:8000`).

### 5. Shutdown the docker images
Once you're done testing the web application, you can stop the containers:

```sh
docker-compose down
```

Add `--volumes` to also delete the database. It is recreated with the sample data on the next start.

## Settings (`.env`)

| Setting | What it does |
|---|---|
| `ENV` | `development` shows the **DUMMY LOGIN** button and reloads HTML on every request. Use `production` on the Jetson. |
| `SESSION_SECRET` | Signs the login cookie. At least 32 random characters. |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub login. Create an OAuth app at <https://github.com/settings/developers> with the callback URL `http://<host>:8000/auth`. |
| `ADMIN_USERS` | Comma-separated GitHub usernames that become admins when they log in. Add `Dummy` to make the dummy login an admin while testing. |
| `JETSON_GATES` | Optional. Links gates to the Jetson that controls them, e.g. `1=http://192.168.1.50:8080`. |

## Roles and permissions

Everyone can view the pages. Actions are checked by the server:

| Action | Needs |
|---|---|
| Open / close a gate | `open_gate` / `close_gate` (admin) |
| Change a user's role, remove a user, remove alerts | `data_control` (admin) |
| Hide alerts | Nothing (only hides them in your own browser) |

New users get the `user` role. Admins change roles by clicking a user on the **Users** page.

## Linking a Jetson (real gates)

Without `JETSON_GATES`, opening and closing a gate is only recorded in the database.
With it, the web app uses the Jetson's own web server (`src/main/http_server.py`, port 8080 from
`config/config.json`). No Python code needs changing:

- **OPEN/CLOSE** sends `OPEN_DOOR` / `CLOSE_DOOR` to the Jetson. If the Jetson can't be reached, the
  gate is not changed and a critical alert is added.
- The gate's card shows the Jetson's **live camera** (`/stream`) and its **door state and CPU** (`/status`).

If the web app runs in Docker on the same Jetson, use `JETSON_GATES=1=http://host.docker.internal:8080`.

## SmartGate Web App Commands

Run the web app without Docker (needs Node.js 20.11 or newer and a running database):
```bash
npm install
DATABASE_URL=postgresql://admin:smartgate@localhost:5432/smartgatedb npm start
```

Restart after changing `app.js` or `controllers/` (HTML, CSS and browser JS changes only need a page refresh):
```bash
docker-compose restart sgwebimage
```

Access SmartGate Database
```bash
docker-compose exec postgres psql -U admin -d smartgatedb
```

Access SmartGate Database Outside Docker Container
```bash
psql -h localhost -U admin -d smartgatedb
```

Database Password: smartgate (see `docker-compose.yml`)

## Project structure

| Path | Contents |
|---|---|
| `app.js` | Starts the server: static files, sessions, Socket.IO, routes |
| `controllers/main_controller.js` | Pages, login, and the HTTP API |
| `controllers/websocket_events.js` | Socket.IO live updates (alerts, users, gates) |
| `controllers/db_controller.js` | All database queries |
| `controllers/jetson_controller.js` | Optional link to the Jetson gate controller |
| `controllers/config.js` | Reads the `.env` settings |
| `frontend/` | HTML pages. `layout.html` is the shared header and footer. |
| `wwwroot/` | CSS, browser JavaScript, images and video, served under `/static/` |
| `models/` | Database schema, loaded by PostgreSQL on first start |

## Important Notes for Developers

- Before running the `docker-compose.yml` file, make sure to **remove any existing containers and volumes** to avoid conflicts. You can do this using the command line or Docker Desktop:

    **Using the command line:**
    ```bash
    # List and remove all containers
    docker ps -a
    docker rm <container_id>

    # List and remove all volumes
    docker volume ls
    docker volume rm <volume_name>
    ```

- If you make changes to `package.json`, the `Dockerfile`, or `docker-compose.yml`, stop the docker composition and rebuild the images using __Step 4__.
- Signed-in sessions are kept in memory, so restarting the web app logs everyone out and clears the users list.
