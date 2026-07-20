/**
 * Pure helpers for ChatInput draft recovery on send failure.
 *
 * Extracted from handleSubmit so they can be unit-tested against production
 * logic without a DOM or React renderer.
 */

/**
 * Decides whether the sent draft should be flushed to localStorage immediately
 * at submit time (before the textarea is cleared) and whether the debounced
 * draft-persist effect should be suppressed for the next render cycle.
 *
 * Background: typing triggers a debounced persist (500 ms).  When the user
 * submits, `setMessage('')` causes a re-render that re-runs the debounced
 * effect with `message = ''`.  Without intervention the effect cancels the
 * pending "hello world" timer and schedules a new timer to persist `''`,
 * which fires ~500 ms later and wipes localStorage before the send settles.
 *
 * The fix is two-pronged:
 *  1. Flush the exact sent text to localStorage *before* clearing the textarea
 *     so the draft is durable from the moment of submission.
 *  2. Set `skipNextDraftPersistRef = true` so the effect triggered by
 *     `setMessage('')` skips scheduling the empty-draft write.
 *
 * Rules:
 *  - Only flush when there is text to flush (`inputTextBeforeSend` non-empty).
 *  - The skip flag is always set when flushing so the two actions stay in sync.
 *  - When `persistChatDraft` is false the debounced path is never reached
 *    (the effect immediately clears instead), so the skip flag has no effect
 *    there; but we still flush for failure-recovery purposes and accept that
 *    the effect will overwrite it — `recoverDraft()` in the catch re-writes it.
 */
export function shouldFlushDraftAtSubmit(opts: {
    inputTextBeforeSend: string;
}): boolean {
    return opts.inputTextBeforeSend.length > 0;
}

/**
 * Decides whether the failed-send's input text should be restored to the
 * visible textarea.
 *
 * Rules:
 *  - Only act when `inputTextBeforeSend` is non-empty (queuedOnly sends have
 *    nothing to restore).
 *  - Only restore the visible textarea when the active session is still the
 *    same session that initiated the send (`currentSessionId === sendSessionId`)
 *    AND the textarea is still empty (`currentMessage === ''`).  A non-empty
 *    textarea means the user typed new text while the send was in-flight and
 *    must not be clobbered.
 *  - The persisted draft is always written back by the caller regardless of
 *    this return value, so the text survives a session switch or page reload.
 */
export function shouldRestoreVisibleInput(opts: {
    inputTextBeforeSend: string;
    sendSessionId: string | null;
    currentSessionId: string | null;
    currentMessage: string;
}): boolean {
    const { inputTextBeforeSend, sendSessionId, currentSessionId, currentMessage } = opts;
    if (!inputTextBeforeSend) return false;
    if (currentSessionId !== sendSessionId) return false;
    if (currentMessage !== '') return false;
    return true;
}

/**
 * Decides whether the success-path draft deletion is safe to execute.
 *
 * At submit time we flush `inputTextBeforeSend` to localStorage so the draft
 * is durable.  On confirmed send success we want to clear it — but only if
 * the stored draft still matches what we sent.  A mismatch means the user
 * typed a new draft while the send was in-flight; we must leave it alone.
 *
 * @param sentText    The text that was sent (raw snapshot before clearing).
 * @param storedDraft Current value of localStorage for the send-session.
 */
export function shouldClearDraftOnSuccess(opts: {
    sendSessionId: string | null;
    sentText: string;
    storedDraft: string;
}): boolean {
    const { sentText, storedDraft } = opts;
    // Clear when the stored draft is still exactly what we sent (we flushed it
    // at submit time, so this is the normal success case) or is already empty.
    // Any other value means the user typed a new draft in-flight — leave it.
    if (storedDraft === '' || storedDraft === sentText) return true;
    return false;
}
