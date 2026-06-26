const R  = '\x1b[0m';
const DIM = '\x1b[2m';
const C  = '\x1b[36m';   // cyan
const G  = '\x1b[32m';   // green
const Y  = '\x1b[33m';   // yellow
const RE = '\x1b[31m';   // red
const M  = '\x1b[35m';   // magenta
const BL = '\x1b[34m';   // blue
const W  = '\x1b[37m';   // white

const METHOD_COLOR = { GET: BL, POST: G, PUT: C, PATCH: M, DELETE: RE };

function ts() {
  return DIM + new Date().toISOString().replace('T', ' ').slice(0, 19) + R + ' ';
}

const log = {
  info:    (tag, msg) => console.log(`${ts()}${C}[${tag}]${R} ${msg}`),
  ok:      (tag, msg) => console.log(`${ts()}${G}[${tag}]${R} ${msg}`),
  warn:    (tag, msg) => console.warn(`${ts()}${Y}[${tag}]${R} ${msg}`),
  error:   (tag, msg) => console.error(`${ts()}${RE}[${tag}]${R} ${msg}`),

  http(method, path, status, ms) {
    const sc = status < 300 ? G : status < 400 ? C : status < 500 ? Y : RE;
    const mc = METHOD_COLOR[method] || W;
    console.log(`${ts()}${DIM}http ${R}${mc}${method.padEnd(6)}${R} ${path.padEnd(45)} ${sc}${status}${R} ${DIM}${ms}ms${R}`);
  },
};

module.exports = log;
