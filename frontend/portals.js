// Runs the demo portals. Each role is its own server.js process on its own port,
// which is what makes the ports meaningful: the page has no role switcher, so the
// only thing that decides which portal you get is which port you hit.
//
//   node portals.js            -> all three
//   node portals.js teacher    -> just the teacher portal
//
// Auth removed: separate ports are a demo convenience, NOT isolation. Every
// portal is open to anyone who can reach its port.
const path = require('path');
const { fork } = require('child_process');

const PORTS = {
  student: Number(process.env.STUDENT_PORT) || 3000,
  teacher: Number(process.env.TEACHER_PORT) || 3001,
  parent: Number(process.env.PARENT_PORT) || 3002,
};

const SERVER = path.join(__dirname, 'server.js');

// Every portal advertises the same port map so the sidebar links resolve.
function envFor(role) {
  return {
    ...process.env,
    PORTAL_ROLE: role,
    PORT: String(PORTS[role]),
    STUDENT_PORT: String(PORTS.student),
    TEACHER_PORT: String(PORTS.teacher),
    PARENT_PORT: String(PORTS.parent),
  };
}

const requested = process.argv[2];

if (requested) {
  if (!PORTS[requested]) {
    console.error(`Unknown portal "${requested}". Expected one of: ${Object.keys(PORTS).join(', ')}`);
    process.exit(1);
  }
  // Single portal: no supervisor needed, just become the server.
  Object.assign(process.env, envFor(requested));
  require(SERVER);
  return;
}

let shuttingDown = false;

const children = Object.keys(PORTS).map(role => {
  const child = fork(SERVER, [], { env: envFor(role), stdio: 'inherit' });
  child.on('exit', code => {
    if (shuttingDown) return;
    console.error(`[portals] ${role} exited (${code}) — stopping the rest.`);
    shutdown(code === null ? 1 : code);
  });
  return child;
});

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[portals] student  http://127.0.0.1:%d', PORTS.student);
console.log('[portals] teacher  http://127.0.0.1:%d', PORTS.teacher);
console.log('[portals] parent   http://127.0.0.1:%d', PORTS.parent);
