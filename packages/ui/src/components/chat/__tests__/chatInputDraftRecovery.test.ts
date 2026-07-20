/**
 * Tests for ChatInput draft recovery helpers.
 *
 * These tests import the production-exported pure functions from
 * chatInputDraftRecovery.ts so any drift in the implementation is caught
 * immediately — no inline replica to keep in sync.
 */
import { describe, expect, test } from 'bun:test';
import {
    shouldFlushDraftAtSubmit,
    shouldRestoreVisibleInput,
    shouldClearDraftOnSuccess,
} from '../chatInputDraftRecovery';

// ---------------------------------------------------------------------------
// shouldFlushDraftAtSubmit
// ---------------------------------------------------------------------------

describe('shouldFlushDraftAtSubmit', () => {
    test('returns true when there is text to flush', () => {
        expect(shouldFlushDraftAtSubmit({ inputTextBeforeSend: 'hello world' })).toBe(true);
    });

    test('returns false for empty string (queuedOnly path has nothing to flush)', () => {
        expect(shouldFlushDraftAtSubmit({ inputTextBeforeSend: '' })).toBe(false);
    });

    test('returns true for whitespace-only text (still non-empty)', () => {
        expect(shouldFlushDraftAtSubmit({ inputTextBeforeSend: '  ' })).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// shouldRestoreVisibleInput
// ---------------------------------------------------------------------------

describe('shouldRestoreVisibleInput', () => {
    const base = {
        inputTextBeforeSend: 'hello world',
        sendSessionId: 'session-1',
        currentSessionId: 'session-1',
        currentMessage: '',
    };

    test('returns true when all conditions are met', () => {
        expect(shouldRestoreVisibleInput(base)).toBe(true);
    });

    test('returns false when inputTextBeforeSend is empty (queuedOnly path)', () => {
        expect(shouldRestoreVisibleInput({ ...base, inputTextBeforeSend: '' })).toBe(false);
    });

    test('returns false when user typed new text while send was in-flight', () => {
        expect(shouldRestoreVisibleInput({ ...base, currentMessage: 'new text' })).toBe(false);
    });

    test('returns false when user switched to a different session', () => {
        expect(shouldRestoreVisibleInput({ ...base, currentSessionId: 'session-2' })).toBe(false);
    });

    test('returns false when both session switched and new text typed', () => {
        expect(shouldRestoreVisibleInput({
            ...base,
            currentSessionId: 'session-2',
            currentMessage: 'new text',
        })).toBe(false);
    });

    test('handles null sendSessionId (new-session draft)', () => {
        expect(shouldRestoreVisibleInput({
            ...base,
            sendSessionId: null,
            currentSessionId: null,
        })).toBe(true);
    });

    test('returns false when sendSessionId is null but currentSessionId is a real session', () => {
        expect(shouldRestoreVisibleInput({
            ...base,
            sendSessionId: null,
            currentSessionId: 'session-1',
        })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// shouldClearDraftOnSuccess
// ---------------------------------------------------------------------------

describe('shouldClearDraftOnSuccess', () => {
    const base = {
        sendSessionId: 'session-1',
        sentText: 'hello world',
        storedDraft: 'hello world',
    };

    test('clears when stored draft matches sent text exactly (normal success after flush)', () => {
        expect(shouldClearDraftOnSuccess(base)).toBe(true);
    });

    test('clears when stored draft is already empty', () => {
        expect(shouldClearDraftOnSuccess({ ...base, storedDraft: '' })).toBe(true);
    });

    test('does NOT clear when user typed a new draft while send was in-flight', () => {
        expect(shouldClearDraftOnSuccess({ ...base, storedDraft: 'new draft typed by user' })).toBe(false);
    });

    test('does NOT clear when stored draft is a superset of sent text', () => {
        expect(shouldClearDraftOnSuccess({ ...base, storedDraft: 'hello world and more' })).toBe(false);
    });

    test('does NOT clear when stored draft is a prefix of sent text', () => {
        expect(shouldClearDraftOnSuccess({ ...base, storedDraft: 'hello' })).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Debounce-race scenario tests
//
// These tests simulate the full submit → settle sequence using the three
// production helpers together, representing the races described in the fix.
// ---------------------------------------------------------------------------

describe('debounce-race scenarios', () => {
    /**
     * Minimal simulation of the localStorage slot for one session.
     * Represents what getStoredDraft / saveStoredDraft operate on.
     */
    function makeStore(initial = '') {
        let value = initial;
        return {
            get: () => value,
            set: (v: string) => { value = v; },
        };
    }

    test('race A: flush at submit prevents debounce from wiping draft before send settles', () => {
        // Arrange: user typed "hello world"; debounce has NOT yet fired (store is empty).
        const store = makeStore('');
        const inputTextBeforeSend = 'hello world';

        // Act: submit — flush the draft immediately (simulates persistDraftImmediately).
        if (shouldFlushDraftAtSubmit({ inputTextBeforeSend })) {
            store.set(inputTextBeforeSend);
            // skipNextDraftPersistRef would be set here in the component.
        }

        // Simulate: debounce fires with '' (the race we're preventing).
        // In the real component this is suppressed by skipNextDraftPersistRef,
        // but here we verify the store already has the correct value before
        // the debounce could fire.
        const storedAfterFlush = store.get();
        expect(storedAfterFlush).toBe('hello world');

        // Simulate: send fails — recoverDraft writes back (belt-and-suspenders).
        store.set(inputTextBeforeSend);
        expect(store.get()).toBe('hello world');
    });

    test('race B: success-match works when draft was flushed at submit time', () => {
        // Arrange: draft was flushed at submit (store = sentText).
        const store = makeStore('hello world');
        const inputTextBeforeSend = 'hello world';

        // Act: send succeeds — check whether to clear.
        const storedDraft = store.get();
        const shouldClear = shouldClearDraftOnSuccess({
            sendSessionId: 'session-1',
            sentText: inputTextBeforeSend,
            storedDraft,
        });

        expect(shouldClear).toBe(true);
        if (shouldClear) store.set('');
        expect(store.get()).toBe('');
    });

    test('race B: success-match leaves draft when user typed new text in-flight', () => {
        // Arrange: user typed new draft while send was in-flight.
        const store = makeStore('new draft typed while waiting');
        const inputTextBeforeSend = 'hello world';

        const storedDraft = store.get();
        const shouldClear = shouldClearDraftOnSuccess({
            sendSessionId: 'session-1',
            sentText: inputTextBeforeSend,
            storedDraft,
        });

        expect(shouldClear).toBe(false);
        // Store must be untouched.
        expect(store.get()).toBe('new draft typed while waiting');
    });

    test('session-switch: recoverDraft persists to send-session but does not restore textarea', () => {
        // Arrange: send was initiated on session-1, user switched to session-2.
        const sendSessionId = 'session-1';
        const currentSessionId = 'session-2'; // live value after switch
        const inputTextBeforeSend = 'hello world';
        const store = makeStore('hello world'); // flushed at submit time

        // Simulate recoverDraft:
        // 1. Always write back to send-session's slot.
        store.set(inputTextBeforeSend);
        expect(store.get()).toBe('hello world'); // draft preserved for session-1

        // 2. shouldRestoreVisibleInput returns false (different session).
        const shouldRestore = shouldRestoreVisibleInput({
            inputTextBeforeSend,
            sendSessionId,
            currentSessionId,
            currentMessage: '', // textarea is empty (session-2's fresh input)
        });
        expect(shouldRestore).toBe(false); // must NOT clobber session-2's textarea
    });

    test('no-clobber: recoverDraft does not restore textarea when user typed new text', () => {
        const inputTextBeforeSend = 'hello world';
        const shouldRestore = shouldRestoreVisibleInput({
            inputTextBeforeSend,
            sendSessionId: 'session-1',
            currentSessionId: 'session-1',
            currentMessage: 'new text typed by user',
        });
        expect(shouldRestore).toBe(false);
    });
});
