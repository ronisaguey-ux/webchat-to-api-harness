'use strict';

const { checkDrift } = require('./drift');
const { judgeDrift } = require('./drift_judge');

const DEFAULTS = {
    mode: Number(process.env.DRIFT_DETECT || '2'),
    threshold: Number(process.env.DRIFT_THRESHOLD || '1'),
    weakSignalThreshold: Number(process.env.DRIFT_WEAK_SIGNAL_THRESHOLD || '1'),
    escalationCount: Number(process.env.DRIFT_ESCALATION_COUNT || '3'),
    judgeCooldownMs: Number(process.env.DRIFT_JUDGE_COOLDOWN_MS || '120000'),
    judgeCacheTtlMs: Number(process.env.DRIFT_JUDGE_CACHE_TTL_MS || '3600000'),
    maxExcerptChars: 4000,
    judgeFn: null,
};

function now() { return Date.now(); }

class MultiSignalGatewayGate {
    constructor(opts = {}) {
        const o = Object.assign({}, DEFAULTS, opts);
        this.mode = o.mode;
        this.threshold = o.threshold;
        this.weakSignalThreshold = o.weakSignalThreshold;
        this.escalationCount = o.escalationCount;
        this.judgeCooldownMs = o.judgeCooldownMs;
        this.judgeCacheTtlMs = o.judgeCacheTtlMs;
        this.maxExcerptChars = o.maxExcerptChars;
        this.judgeFn = o.judgeFn || judgeDrift;
        this.buffer = [];
        this.cumulative = 0;
        this.lastJudgeAt = 0;
        this.judgeCache = null;
        this.escalations = 0;
    }

    reset() {
        this.buffer = [];
        this.cumulative = 0;
        this.lastJudgeAt = 0;
        this.judgeCache = null;
        this.escalations = 0;
    }

    score(thinkText) { return checkDrift(thinkText); }

    _pushWeak(score, source) {
        const s = Math.max(0, Number(score) || 0);
        this.cumulative += s;
        this.buffer.push({ at: now(), score: s, source: String(source || '').slice(0, 200) });
        if (this.buffer.length > 20) {
            const dropped = this.buffer.shift();
            this.cumulative = Math.max(0, this.cumulative - (dropped.score || 0));
        }
    }

    _shouldEscalate() {
        const overCount = this.buffer.length >= this.escalationCount;
        const overCumulative = this.cumulative >= this.escalationCount * this.weakSignalThreshold;
        return overCount && overCumulative;
    }

    _cacheValid() {
        if (!this.judgeCache) return false;
        if (now() - this.judgeCache.at > this.judgeCacheTtlMs) {
            this.judgeCache = null;
            return false;
        }
        return true;
    }

    _cooldownElapsed() { return now() - this.lastJudgeAt >= this.judgeCooldownMs; }

    async feed(thinkText, userPrompt) {
        if (this.mode === 0) return { paused: false, gate: null, verdict: null };
        const text = String(thinkText || '');
        if (!text.trim()) return { paused: false, gate: null, verdict: null };
        const gate = this.score(text);
        if (this.mode === 1) {
            if (!gate.drifted) return { paused: false, gate, verdict: null };
            const verdict = await this._callJudge(text, userPrompt);
            if (verdict && verdict.drifted === false) return { paused: false, gate, verdict };
            return { paused: true, gate, verdict };
        }
        if (gate.drifted) this._pushWeak(gate.score, text);
        if (!this._shouldEscalate()) return { paused: false, gate, verdict: null };
        let verdict = this._maybeJudge(text, userPrompt);
        if (verdict && typeof verdict.then === 'function') verdict = await verdict;
        if (verdict && verdict.drifted === false) return { paused: false, gate, verdict };
        return { paused: true, gate, verdict };
    }

    _callJudge(text, userPrompt) {
        this.lastJudgeAt = now();
        this.escalations++;
        const excerpt = String(text).slice(0, this.maxExcerptChars);
        return this.judgeFn(excerpt, userPrompt || '');
    }

    _maybeJudge(text, userPrompt) {
        if (this._cacheValid()) {
            return Object.assign({}, this.judgeCache.verdict, { cached: true });
        }
        if (!this._cooldownElapsed()) {
            return { drifted: true, reason: 'judge cooldown (escalated, prior verdict)', pending: true };
        }
        const p = this._callJudge(text, userPrompt);
        if (p && typeof p.then === 'function') {
            p.then((v) => {
                if (v && typeof v === 'object' && typeof v.drifted === 'boolean') {
                    this.judgeCache = { at: now(), verdict: v };
                }
            }).catch(() => {});
        } else if (p && typeof p === 'object' && typeof p.drifted === 'boolean') {
            this.judgeCache = { at: now(), verdict: p };
        }
        return p;
    }
}

module.exports = { MultiSignalGatewayGate, DEFAULTS };
