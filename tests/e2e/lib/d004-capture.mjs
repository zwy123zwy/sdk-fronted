/**
 * D004 捕获护栏：**「窗口捕获到没有」必须是一个可判定的、带证据的结论**。
 *
 * ## 为什么要这一层（T29 尾部实测 + T32 的教训）
 *
 * 1. 离线副本的 intent 锚点是**异步**写入、且写入值取自**发起那一刻**的账目
 *    （`offline-store.ts` 的 `requestAnchor()`：`IntTentState.total_enqueued` 在 putMeta 调用时求值，
 *    在途锚点被 `anchorQueued` 合并）。SIGKILL 落在 Δt=0 时，只有最早那份锚点落盘 →
 *    重启后 `prewrite_commit_lost` **偏小**（WebKit 实测 10，而期望 1000）。这不是数据丢失
 *    （`durable` 仍 1000/1000），而是**计数**来不及落。出处：`docs/reports/e2e-d004-hardkill.md`
 *    局限第 6 条「**合并锚点的残余窗口**」。
 * 2. 旧判据是**两个布尔**（`windowCaptured` = `commitLost > 0`；`exposureReconciles` =
 *    `存活 + 计数 === 期望`），单次运行拿哪个就是哪个 → 同一格一会儿红一会儿绿。
 * 3. T32 吃过一次亏：WebKit 有 3 格是**空白**（`{存活 0, 计数 0, 期望 N}`），
 *    很容易被读成「没丢」。**空白是「没有计数证据」，不是「0 丢失」** —— 本模块用
 *    `lostEvents: number | null` 把两者变成**结构上不可混淆**的两个值。
 *
 * ## 判据来源（不改，只包一层）
 *
 * - `tests/e2e/lib/d004-run.mjs:234`：`windowCaptured = inventory.commitLoss.events > 0`
 * - `tests/e2e/lib/d004-run.mjs:225-228`：`exposureReconciles = 存活 + 未提交 === 期望`
 * - `tests/e2e/durability.spec.mjs:61-68`：`windowCaptured ⇒ exposureReconciles`（D004-B/C）
 *
 * 本模块**不重新定义**这些判据，只做三件事：
 *   a. 把一对布尔压成互斥的**轮次判定**（`ROUND_VERDICT`），并显式区分
 *      「窗口未捕获（空白）」与「0 丢失」；
 *   b. 把「捕获格必须**连续 N 轮完整**才算通过」变成 `judgeCaptureRounds()`；
 *      单轮不完整 → 该轮记为**抖动/未捕获**（不是直接判失败），最终判定由 N 轮结果给出；
 *   c. 提供 `assertNoBlankAsZeroLoss()`：任何把空白/欠计数读成「0 丢失」的判定都直接抛错。
 *
 * ## 变异开关（只用于变异验证，默认关闭）
 *
 * `D004_CAPTURE_GUARD=off` 把本模块降级为**护栏前的读法**：
 * `zeroLoss = (commitLost === 0)`（空白即当 0 丢失）、判定退化为**单轮**（看最后一轮）。
 * 此时 `tests/e2e/lib/d004-anchor-window.mjs` 与 `D004-CAP` 用例必须变红。
 */

/** 需要「连续 N 轮完整」才算通过的捕获格（T29 尾部实测到残余窗口的 3 格）。 */
export const GATED_CELLS = Object.freeze(['pending-d0', 'preflush-d0', 'preflush-small']);

/** N：要求的**连续完整**轮数。3 的理由见 `docs/reports/e2e-real-browser.md` 追加节。 */
export const DEFAULT_REQUIRED_STREAK = 3;
/** M：单格最大轮数（有界重试；不完整轮记为抖动后继续，最多跑到 6 轮）。 */
export const DEFAULT_MAX_ROUNDS = 6;

/** 单轮判定（互斥）。 */
export const ROUND_VERDICT = Object.freeze({
  /** 窗口已捕获（`commitLost > 0`）且对账等式成立 → 这一轮「完整」。 */
  COMPLETE: 'complete',
  /** 窗口已捕获，但 `存活 + 计数 < 期望`：锚点合并残余窗口（计数偏小）。 */
  UNDERCOUNTED: 'undercounted',
  /** 没有任何计数证据（`commitLost === 0`）且没全读回：**空白**，不等于 0 丢失。 */
  BLANK: 'blank',
  /** `存活 + 计数 > 期望`：重复/重复计数，测量无效。 */
  OVERCOUNTED: 'overcounted',
  /** 半落盘（`partiallyReadable > 0`）或出现期望外事件：D004-A 的完整性问题。 */
  TORN: 'torn',
  /** 杀在提交之后：全部读回且计数 0 —— **这一种才是「0 丢失」**。 */
  WINDOW_MISSED: 'window-missed',
});

/** 一个捕获格的最终判定（由 N 轮结果给出）。 */
export const GATE_VERDICT = Object.freeze({
  /** N 轮连续完整，且没有被丢弃的轮。 */
  STABLE: 'stable-complete',
  /** 达成 N 轮连续完整，但中间有被丢弃的抖动轮（抖动率一并报出）。 */
  JITTER: 'complete-with-jitter',
  /** M 轮内**始终**没达成 N 轮连续完整：计数残余窗口是系统性的（不是抖动）。 */
  NEVER_COMPLETE: 'never-complete',
  /** M 轮**全**是空白：连一次计数证据都没有 —— 明确**不得**读作 0 丢失。 */
  BLANK_ONLY: 'blank-only',
  /** M 轮里没有一轮捕获到窗口（杀得太晚/负载太轻）。 */
  NEVER_CAPTURED: 'window-never-captured',
  /** 非捕获格：只报逐轮分类，不参与连续 N 轮判定。 */
  NOT_GATED: 'not-gated',
});

/** 护栏是否生效。`D004_CAPTURE_GUARD=off` 时降级为护栏前的单轮读法（变异验证用）。 */
export function guardEnabled(env = globalThis.process?.env) {
  return env?.['D004_CAPTURE_GUARD'] !== 'off';
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * 取一轮的事实。入参可以是 `d004-run.mjs` 的完整 cell（`survived` / `d004` 两个子对象），
 * 也可以是同样的扁平写法 —— 但仍然**只认这些字段**，避免与 runner 的 JSON 形状漂移。
 */
export function roundFacts(cell) {
  const survived = cell.survived ?? {};
  const d004 = cell.d004 ?? {};
  const expectedEvents = num(cell.expectedEvents);
  const survivors = num(survived.events);
  const commitLost = num(d004.uncommittedFromIntent ?? cell.commitLostEvents);
  return {
    name: cell.name,
    group: cell.group ?? null,
    expectedEvents,
    survivors,
    commitLost,
    missingEvents: num(survived.missingEvents ?? expectedEvents - survivors),
    partiallyReadable: num(survived.partiallyReadable),
    unexpectedEvents: num(survived.unexpectedEvents),
  };
}

/**
 * 判定一轮。所有「窗口捕获」结论都带证据字段，且：
 *
 * - `zeroLoss` **只**由「期望事件全部读回」正面证明（`survivors === expectedEvents`），
 *   与 `commitLost` 是否为 0 **无关**；
 * - `lostEvents` 只在计数可信时是数字（**0 丢失**就是 `0`），空白/欠计数时一律 `null`，
 *   并把「至少丢了多少」放在 `lostEventsLowerBound`（= 期望 − 存活）。
 */
export function classifyRound(cell, { round = 0 } = {}) {
  const f = roundFacts(cell);
  const unaccountedEvents = f.expectedEvents - f.survivors - f.commitLost;
  const windowCaptured = f.commitLost > 0; // d004-run.mjs:234 的原判据
  const reconciles = f.survivors + f.commitLost === f.expectedEvents; // d004-run.mjs:225-228
  const torn = f.partiallyReadable > 0 || f.unexpectedEvents > 0;
  const allReadBack = f.survivors === f.expectedEvents;

  let verdict;
  if (torn) verdict = ROUND_VERDICT.TORN;
  else if (allReadBack && f.commitLost === 0) verdict = ROUND_VERDICT.WINDOW_MISSED;
  else if (windowCaptured && reconciles) verdict = ROUND_VERDICT.COMPLETE;
  else if (windowCaptured && unaccountedEvents < 0) verdict = ROUND_VERDICT.OVERCOUNTED;
  else if (windowCaptured) verdict = ROUND_VERDICT.UNDERCOUNTED;
  else verdict = ROUND_VERDICT.BLANK;

  if (!guardEnabled()) {
    // ---- 护栏前（变异体）的读法：空白 == 计数 0 == 「没丢」，且只有「对账成立」才算完整。
    return {
      name: f.name,
      round,
      group: f.group,
      expectedEvents: f.expectedEvents,
      survivors: f.survivors,
      commitLost: f.commitLost,
      missingEvents: f.missingEvents,
      unaccountedEvents,
      windowCaptured,
      reconciles,
      verdict,
      complete: reconciles,
      zeroLoss: f.commitLost === 0, // 变异体：空白被当成 0 丢失
      lostEvents: f.commitLost === 0 ? 0 : null, // 变异体：空白被当成「计数丢失 0」
      lostEventsLowerBound: Math.max(0, f.expectedEvents - f.survivors),
      blank: verdict === ROUND_VERDICT.BLANK,
      blankIsNotZeroLoss: false, // 变异体：不做这个区分
      countedEvidence: windowCaptured,
      guard: 'off',
    };
  }

  const zeroLoss = allReadBack; // ★ 只有「全部读回」才是 0 丢失（正面证据）
  const countedEvidence = windowCaptured;
  // `lostEvents` 是**计数轴**：`prewrite_commit_lost` 可信时给数字，不可信（空白/欠计数/测量无效）时给 `null`。
  // 因此「空白」在 JSON 里是 `null`，而「唯一的 0 丢失」是 `0` —— 类型不同，读表方不可能混淆。
  const countTrustworthy = verdict === ROUND_VERDICT.COMPLETE || verdict === ROUND_VERDICT.WINDOW_MISSED;
  return {
    name: f.name,
    round,
    group: f.group,
    expectedEvents: f.expectedEvents,
    survivors: f.survivors,
    commitLost: f.commitLost,
    missingEvents: f.missingEvents,
    unaccountedEvents,
    windowCaptured,
    reconciles,
    verdict,
    complete: verdict === ROUND_VERDICT.COMPLETE,
    zeroLoss,
    // 计数不可信（空白/欠计数/多计/半落盘）→ null；可信时就是实际计数（0 就是真 0）。
    lostEvents: countTrustworthy ? f.commitLost : null,
    lostEventsLowerBound: Math.max(0, f.expectedEvents - f.survivors),
    blank: verdict === ROUND_VERDICT.BLANK,
    /** 常量：空白**永远**不是 0 丢失（供读表方与断言方共用同一个词）。 */
    blankIsNotZeroLoss: true,
    countedEvidence,
    guard: 'on',
  };
}

/** 一句人类可读的轮次描述；空白与欠计数都显式带「≠0 丢失」。 */
export function describeRound(round) {
  const head = `第 ${round.round + 1} 轮 ${round.name}：存活 ${round.survivors}/${round.expectedEvents}` +
    `，计数 ${round.commitLost}，差值 ${round.unaccountedEvents}`;
  switch (round.verdict) {
    case ROUND_VERDICT.COMPLETE:
      return `${head} → **完整**（窗口已捕获且对账等式成立）`;
    case ROUND_VERDICT.UNDERCOUNTED:
      return `${head} → **窗口已捕获但计数偏小**（锚点合并残余窗口）：${round.unaccountedEvents} 个事件**未被单独计数**；` +
        `已读回 ${round.survivors}，至少丢 ${round.lostEventsLowerBound} —— **≠0 丢失**`;
    case ROUND_VERDICT.BLANK:
      return `${head} → **空白：窗口未捕获 / 无计数证据**：磁盘上没有 intent 痕迹，` +
        '无法区分「窗口在途但锚点没落」与「窗口真没被捕获」；' +
        `至少丢 ${round.lostEventsLowerBound} —— **≠0 丢失，不得计入「已对账」**`;
    case ROUND_VERDICT.WINDOW_MISSED:
      return `${head} → **杀在提交之后**：${round.survivors}/${round.expectedEvents} 全部读回、计数 0（唯一的「0 丢失」）`;
    case ROUND_VERDICT.OVERCOUNTED:
      return `${head} → **多计**（存活 + 计数 > 期望），测量无效`;
    default:
      return `${head} → **半落盘/出现期望外事件**，D004-A 的完整性问题`;
  }
}

/** 从逐轮判定现算最终判定（judgeCaptureRounds 与 spec 里的自洽性检查共用同一实现）。 */
export function deriveGateVerdict(rounds, { gated, requiredStreak }) {
  if (!gated) return GATE_VERDICT.NOT_GATED;
  if (rounds.length === 0) return GATE_VERDICT.NEVER_CAPTURED;
  let streak = 0;
  let best = 0;
  for (const r of rounds) {
    streak = r.complete ? streak + 1 : 0;
    best = Math.max(best, streak);
  }
  if (best >= requiredStreak) {
    return rounds.some((r) => !r.complete) ? GATE_VERDICT.JITTER : GATE_VERDICT.STABLE;
  }
  if (rounds.every((r) => r.blank)) return GATE_VERDICT.BLANK_ONLY;
  if (rounds.every((r) => !r.countedEvidence)) return GATE_VERDICT.NEVER_CAPTURED;
  return GATE_VERDICT.NEVER_COMPLETE;
}

/**
 * 对 N 轮结果给最终判定。
 *
 * - 达成**连续 `requiredStreak` 轮完整** → `stable-complete`（无抖动轮）/ `complete-with-jitter`；
 * - 没达成 → `never-complete` / `blank-only` / `window-never-captured`（三者互斥，逐格报出）。
 *
 * `selectedRoundIndex` 是交给既有 D004-A/B/C 断言的那一轮（**不降低既有通过标准**）：
 * 优先「达成 streak 的那一段的最后一轮」，否则第一个完整轮，否则第一个捕获到窗口的轮，
 * 否则最后一轮 —— 因此若本格一次完整轮都没有，交给既有断言的仍是**未对账**的那一轮。
 */
export function judgeCaptureRounds(name, rounds, options = {}) {
  const gated = options.gated ?? GATED_CELLS.includes(name);
  const requiredStreak = options.requiredStreak ?? DEFAULT_REQUIRED_STREAK;
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;

  if (!guardEnabled()) {
    // ---- 护栏前（变异体）的读法：只看最后一轮，且不要求连续 N 轮。
    const last = rounds[rounds.length - 1];
    const verdict = !gated
      ? GATE_VERDICT.NOT_GATED
      : last === undefined
        ? GATE_VERDICT.NEVER_CAPTURED
        : last.complete
          ? GATE_VERDICT.STABLE
          : rounds.every((r) => r.blank)
            ? GATE_VERDICT.BLANK_ONLY
            : rounds.every((r) => !r.countedEvidence)
              ? GATE_VERDICT.NEVER_CAPTURED
              : GATE_VERDICT.NEVER_COMPLETE;
    return {
      name,
      gated,
      requiredStreak,
      maxRounds,
      roundCount: rounds.length,
      verdict,
      passed: verdict === GATE_VERDICT.STABLE || verdict === GATE_VERDICT.JITTER,
      bestStreak: rounds[rounds.length - 1]?.complete ? 1 : 0,
      discardedRounds: 0,
      jitterRate: 0,
      classes: tallyClasses(rounds),
      selectedRoundIndex: rounds.length - 1,
      blankIsNotZeroLoss: false,
      rounds: rounds.map(briefRound),
      guard: 'off',
    };
  }

  const classes = tallyClasses(rounds);
  const discarded = rounds.length - classes[ROUND_VERDICT.COMPLETE];
  let streak = 0;
  let bestStreak = 0;
  for (const r of rounds) {
    streak = r.complete ? streak + 1 : 0;
    bestStreak = Math.max(bestStreak, streak);
  }
  const verdict = deriveGateVerdict(rounds, { gated, requiredStreak });

  // 交给既有断言的那一轮。
  let selectedRoundIndex = rounds.length - 1;
  if (bestStreak >= requiredStreak) {
    let run = 0;
    for (let i = 0; i < rounds.length; i += 1) {
      run = rounds[i].complete ? run + 1 : 0;
      if (run >= requiredStreak) selectedRoundIndex = i;
    }
  } else {
    const completeIdx = rounds.findIndex((r) => r.verdict === ROUND_VERDICT.COMPLETE);
    const capturedIdx = rounds.findIndex((r) => r.countedEvidence);
    selectedRoundIndex = completeIdx >= 0 ? completeIdx : capturedIdx >= 0 ? capturedIdx : rounds.length - 1;
  }

  return {
    name,
    gated,
    requiredStreak,
    maxRounds,
    roundCount: rounds.length,
    verdict,
    /** 是否**通过捕获判定**（连续 N 轮完整）。非捕获格为 `null`（不参与判定）。 */
    passed: gated ? verdict === GATE_VERDICT.STABLE || verdict === GATE_VERDICT.JITTER : null,
    bestStreak,
    discardedRounds: discarded,
    jitterRate: rounds.length === 0 ? 0 : discarded / rounds.length,
    classes,
    selectedRoundIndex,
    /** 本判定里，空白格一律不是 0 丢失（`assertNoBlankAsZeroLoss` 会对每一轮现查）。 */
    blankIsNotZeroLoss: true,
    rounds: rounds.map(briefRound),
    guard: 'on',
  };
}

function tallyClasses(rounds) {
  const out = {};
  for (const key of Object.values(ROUND_VERDICT)) out[key] = 0;
  for (const r of rounds) out[r.verdict] = (out[r.verdict] ?? 0) + 1;
  return out;
}

/** 一轮的紧凑投影（写进 JSON / annotation，避免把整份 inventory 塞进报告）。 */
export function briefRound(round) {
  return {
    round: round.round,
    verdict: round.verdict,
    complete: round.complete,
    windowCaptured: round.windowCaptured,
    reconciles: round.reconciles,
    expectedEvents: round.expectedEvents,
    survivors: round.survivors,
    commitLost: round.commitLost,
    unaccountedEvents: round.unaccountedEvents,
    zeroLoss: round.zeroLoss,
    lostEvents: round.lostEvents,
    lostEventsLowerBound: round.lostEventsLowerBound,
    blankIsNotZeroLoss: round.blankIsNotZeroLoss,
    text: describeRound(round),
  };
}

/**
 * **护栏的核心不变量**：任何被判为空白/欠计数的轮，都不得同时带着「0 丢失」的读数。
 * 违反即抛错（这是 T32 那次误读的结构化防线）。
 */
export function assertNoBlankAsZeroLoss(rounds) {
  for (const r of rounds) {
    const suspicious = r.blank || r.verdict === ROUND_VERDICT.UNDERCOUNTED || r.verdict === ROUND_VERDICT.BLANK;
    if (!suspicious) continue;
    const problems = [];
    if (r.zeroLoss === true) problems.push('zeroLoss=true');
    if (r.lostEvents === 0) problems.push('lostEvents=0');
    if (r.blankIsNotZeroLoss !== true) problems.push('blankIsNotZeroLoss≠true');
    if (r.lostEventsLowerBound < 1) problems.push(`lostEventsLowerBound=${r.lostEventsLowerBound}<1`);
    if (problems.length > 0) {
      throw new Error(
        `${r.name} 第 ${r.round + 1} 轮是「窗口未捕获/欠计数」，却被读成 0 丢失：${problems.join('、')}。` +
          `实际：存活 ${r.survivors}/${r.expectedEvents}，计数 ${r.commitLost}，未计数 ${r.unaccountedEvents}。` +
          '空白/欠计数是「没有计数证据」，不是「没丢」。',
      );
    }
  }
  return true;
}

/** 把若干轮的判定渲染成报告/annotation 用的多行文本。 */
export function renderRounds(rounds) {
  return rounds.map((r) => `- ${describeRound(r)}`).join('\n');
}
