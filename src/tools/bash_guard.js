'use strict';
//
// bash_guard.js — read a shell command as the shell will, before run_bash runs it.
//
// The old guards matched the raw string. `cmd.split(" ")` plus "the last non-flag
// token is the branch" let `git push origin HEAD:main`, `git push origin main:main`
// and `git push -u origin main && echo ok` straight through to main (measured
// 2026-09-25), because the "branch" they saw was `HEAD:main`, `main:main` and `ok`.
//
// This is not a shell parser and does not try to be one. It splits a command into the
// simple commands the shell will run (on ; && || | & newlines, subshell and
// command-substitution brackets), splits each into words honouring quotes, strips the
// wrappers that run another command (env, sudo, nohup, time, xargs, bash -c, eval), and
// hands the resulting argv to the checks. Anything it cannot read as a clean push to a
// feature branch is refused: the cost of a refused push is one retry with an explicit
// branch; the cost of a wrong allow is a commit on main.

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '$(', '`', '{', '}']);

// Split into tokens: words, and the separators above. Quotes group; a backslash escapes
// the next character outside single quotes.
function lex(cmd) {
    const out = [];
    let word = null;
    const push = () => { if (word !== null) out.push({ w: word }); word = null; };
    const s = String(cmd || '');
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === "'") {
            const j = s.indexOf("'", i + 1);
            const end = j === -1 ? s.length : j;
            word = (word || '') + s.slice(i + 1, end);
            i = end;
        } else if (c === '"') {
            let j = i + 1;
            let buf = '';
            while (j < s.length && s[j] !== '"') {
                if (s[j] === '\\' && j + 1 < s.length) { buf += s[j + 1]; j += 2; continue; }
                buf += s[j++];
            }
            word = (word || '') + buf;
            i = j;
        } else if (c === '\\' && i + 1 < s.length) {
            if (s[i + 1] !== '\n') word = (word || '') + s[i + 1];
            i++;
        } else if (c === ' ' || c === '\t') {
            push();
        } else if (c === '\n' || c === ';' || c === '(' || c === ')' || c === '`') {
            push(); out.push({ sep: c });
        } else if (c === '$' && s[i + 1] === '(') {
            push(); out.push({ sep: '$(' }); i++;
        } else if (c === '&' || c === '|') {
            push();
            if (s[i + 1] === c) { out.push({ sep: c + c }); i++; } else if (c === '&' && s[i + 1] === '>') {
                // `&>file` is a redirect, not a background.
                word = '&';
            } else out.push({ sep: c });
        } else if ((c === '{' || c === '}') && word === null && (i + 1 >= s.length || /\s/.test(s[i + 1]) || c === '}')) {
            push(); out.push({ sep: c });
        } else {
            word = (word || '') + c;
        }
    }
    push();
    return out;
}

// The simple commands in `cmd`, each an argv array. Redirections are dropped.
function commands(cmd) {
    const list = [];
    let cur = [];
    for (const t of lex(cmd)) {
        if (t.sep !== undefined) { if (cur.length) list.push(cur); cur = []; continue; }
        cur.push(t.w);
    }
    if (cur.length) list.push(cur);
    return list.map((argv) => argv.filter((w, i) => !isRedirect(w, argv[i - 1])));
}

function isRedirect(w, prev) {
    if (/^\d*(>>?|<<?<?|>&|<&|&>>?)/.test(w)) return true;
    // The target of a bare `>`/`<` operator.
    return prev !== undefined && /^\d*(>>?|<<?<?|&>>?)$/.test(prev);
}

const WRAPPERS_NO_ARGS = new Set(['nohup', 'command', 'builtin', 'exec', 'time', 'nice', 'ionice', 'stdbuf', 'setsid', 'doas']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

// Peel the wrappers off an argv and return the command(s) actually run. A shell given a
// string (`bash -c "…"`, `eval "…"`) contributes every command inside that string.
function unwrap(argv, depth = 0) {
    let a = argv.slice();
    for (;;) {
        while (a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) a.shift();
        if (!a.length) return [];
        const base = a[0].split('/').pop();
        if (base === 'env') {
            a.shift();
            while (a.length && (a[0].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0]))) {
                const opt = a.shift();
                if (opt === '-u' || opt === '-C' || opt === '--unset' || opt === '--chdir') a.shift();
            }
            continue;
        }
        if (base === 'sudo') {
            a.shift();
            while (a.length && a[0].startsWith('-')) {
                const opt = a.shift();
                if (/^-[ugCDhpr]$/.test(opt)) a.shift();
            }
            continue;
        }
        if (base === 'timeout') {
            a.shift();
            while (a.length && a[0].startsWith('-')) {
                const opt = a.shift();
                if (opt === '-s' || opt === '-k' || opt === '--signal' || opt === '--kill-after') a.shift();
            }
            a.shift(); // the duration
            continue;
        }
        if (base === 'xargs') {
            a.shift();
            while (a.length && a[0].startsWith('-')) {
                const opt = a.shift();
                if (/^-[IdEaLnPs]$/.test(opt)) a.shift();
            }
            continue;
        }
        if (WRAPPERS_NO_ARGS.has(base)) {
            a.shift();
            while (a.length && a[0].startsWith('-')) a.shift();
            continue;
        }
        break;
    }
    const base = a[0].split('/').pop();
    if (depth < 4 && base === 'eval') {
        return commands(a.slice(1).join(' ')).flatMap((c) => unwrap(c, depth + 1));
    }
    if (depth < 4 && SHELLS.has(base)) {
        const ci = a.findIndex((w, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(w));
        if (ci !== -1 && a[ci + 1] !== undefined) {
            return commands(a[ci + 1]).flatMap((c) => unwrap(c, depth + 1));
        }
    }
    return [a];
}

function argvs(cmd) {
    return commands(cmd).flatMap((c) => unwrap(c));
}

// ── git push ────────────────────────────────────────────────────────────────

const PROTECTED = new Set(['main', 'master']);
const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const PUSH_OPT_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec', '--recurse-submodules']);
const PUSH_ALL = new Set(['--all', '--mirror', '--branches']);

function isProtectedRef(ref) {
    const r = String(ref || '').replace(/^refs\/heads\//, '');
    return PROTECTED.has(r);
}

// The reason a `git … push …` argv is refused, or null when it pushes only named
// feature branches.
function pushArgvDenial(a) {
    let i = 1;
    while (i < a.length && a[i].startsWith('-')) {
        const opt = a[i].split('=')[0];
        i += (GIT_GLOBAL_WITH_VALUE.has(opt) && !a[i].includes('=')) ? 2 : 1;
    }
    if (a[i] !== 'push') return null;
    const positional = [];
    let deleting = false;
    for (let j = i + 1; j < a.length; j++) {
        const w = a[j];
        if (w === '--') { positional.push(...a.slice(j + 1)); break; }
        if (w.startsWith('-')) {
            const opt = w.split('=')[0];
            if (PUSH_ALL.has(opt)) return `\`${w}\` pushes every branch, main/master included`;
            if (opt === '-d' || opt === '--delete') deleting = true;
            if (PUSH_OPT_WITH_VALUE.has(opt) && !w.includes('=')) j++;
            continue;
        }
        positional.push(w);
    }
    const refspecs = positional.slice(1); // positional[0] is the remote
    if (!refspecs.length) return 'no branch named (a bare push goes to whatever the current branch tracks)';
    for (const spec of refspecs) {
        const s = spec.replace(/^\+/, '');
        const colon = s.indexOf(':');
        const src = colon === -1 ? s : s.slice(0, colon);
        const dst = colon === -1 ? s : s.slice(colon + 1);
        if (isProtectedRef(dst) || (!deleting && isProtectedRef(src) && colon === -1)) {
            return `refspec \`${spec}\` targets ${dst.replace(/^refs\/heads\//, '') || src}`;
        }
        if (colon === -1 && (src === 'HEAD' || src === '@')) {
            return `refspec \`${spec}\` pushes whatever branch is checked out, which may be main/master`;
        }
        if (dst === '' && colon !== -1) continue; // `src:` is not a valid push; git refuses it itself
        if (/[*]/.test(dst) || /^HEAD$|^@$/.test(dst)) {
            return `refspec \`${spec}\` does not name one feature branch`;
        }
    }
    return null;
}

function pushDenial(cmd) {
    for (const a of argvs(cmd)) {
        if (a[0].split('/').pop() !== 'git') continue;
        const why = pushArgvDenial(a);
        if (why) return 'run_bash DENIED: git push requires an explicit feature branch (master/main forbidden): ' + why;
    }
    return null;
}

// ── Destructive commands ────────────────────────────────────────────────────
//
// The Linux deny-list was a substring list, which failed both ways (measured
// 2026-09-25): `rm -r -f`, `rm  -rf /` (two spaces) and `find / -delete` ran, while
// `grep -r halting src/` and `echo reboot notes` were refused because "halt" and
// "reboot" appear somewhere in the string. Commands are now matched on argv: the
// program actually run and the flags actually passed. What is refused is unchanged in
// intent — irreversible system destruction with no place in a coding agent's work.

// Still matched as text: these are not commands but things that must never appear in
// one (secrets, the settings backup) or shapes that are not a single argv (fork bomb,
// raw writes to a block device, a download piped into a shell).
const TEXT_DENY = [
    [/:\s*\(\s*\)\s*\{/, 'fork bomb'],
    [/>\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk)/, '> /dev/<disk>'],
    [/\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/, 'download piped into a shell'],
    [/settings_backup\.json/, 'settings_backup.json'],
    [/ghp_/, 'ghp_'],
    [/TELEGRAM_TOKEN/, 'TELEGRAM_TOKEN'],
    [/BOT_TOKEN/, 'BOT_TOKEN'],
];

const POWER = new Set(['shutdown', 'reboot', 'halt', 'poweroff']);
const DISK = new Set(['wipefs', 'shred']);

// Short flags as a set of letters (`-rf`, `-r -f`, `-fR` all give r and f); long
// flags by name. Stops at `--`.
function flagSet(args) {
    const short = new Set();
    const long = new Set();
    for (const w of args) {
        if (w === '--') break;
        if (w.startsWith('--')) long.add(w.split('=')[0]);
        else if (w.startsWith('-') && w.length > 1) for (const c of w.slice(1)) short.add(c);
    }
    return { short, long };
}

function argvDanger(a) {
    const prog = a[0].split('/').pop();
    const args = a.slice(1);
    const f = flagSet(args);
    if (prog === 'rm') {
        const recursive = f.short.has('r') || f.short.has('R') || f.long.has('--recursive');
        const force = f.short.has('f') || f.long.has('--force');
        if (recursive && force) return 'rm -rf';
    }
    if (prog === 'find') {
        if (args.includes('-delete')) return 'find -delete';
        const ex = args.findIndex((w) => w === '-exec' || w === '-execdir' || w === '-ok' || w === '-okdir');
        if (ex !== -1 && args[ex + 1] && args[ex + 1].split('/').pop() === 'rm') return 'find -exec rm';
    }
    if (POWER.has(prog)) return prog;
    if ((prog === 'init' || prog === 'telinit') && /^[06]$/.test(args[0] || '')) return prog + ' ' + args[0];
    if (prog === 'systemctl' && args.some((w) => /^(poweroff|reboot|halt|kexec)$/.test(w))) return 'systemctl ' + args.find((w) => /^(poweroff|reboot|halt|kexec)$/.test(w));
    if (prog === 'mkfs' || prog.startsWith('mkfs.')) return 'mkfs';
    if (DISK.has(prog)) return prog;
    if (prog === 'dd' && args.some((w) => /^(if|of)=/.test(w))) return 'dd';
    if (prog === 'pkill' && (f.short.has('f') || f.long.has('--full'))) return 'pkill -f';
    if ((prog === 'node' || prog === 'nodejs') && (f.short.has('e') || f.short.has('p') || f.long.has('--eval') || f.long.has('--print'))) {
        // `node -e` is refused because the command text is the whole program: nothing
        // about it can be checked here. Scripts on disk go through the path fence.
        return 'node -e';
    }
    if (prog === 'chown' && (f.short.has('R') || f.long.has('--recursive'))) return 'chown -R';
    if (prog === 'chmod' && (f.short.has('R') || f.long.has('--recursive')) && args.includes('/')) return 'chmod -R … /';
    return null;
}

// The reason `cmd` is refused as destructive, or null. `windowsPatterns` is the
// platform's text list, used as-is on Windows, where cmd.exe syntax is not parsed here.
function dangerDenial(cmd, { windows = false, windowsPatterns = [] } = {}) {
    const text = String(cmd || '');
    if (windows) {
        const hit = windowsPatterns.find((p) => text.includes(p));
        return hit ? 'run_bash DENIED: command matches dangerous pattern: ' + hit : null;
    }
    for (const [re, name] of TEXT_DENY) {
        if (re.test(text)) return 'run_bash DENIED: command matches dangerous pattern: ' + name;
    }
    for (const a of argvs(text)) {
        const hit = argvDanger(a);
        if (hit) return 'run_bash DENIED: command matches dangerous pattern: ' + hit;
    }
    return null;
}

module.exports = { lex, commands, argvs, unwrap, pushDenial, pushArgvDenial, dangerDenial };
