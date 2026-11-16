// Timer queue / popout-snapshot behaviour in the real ui.js. Regressions:
//  - stopping the timer (or removing the running topic) left the last topic's
//    notes in the bar, so the popout kept showing a topic that was gone
//  - an Outline sync replaced the queue without saving it, so the old topics
//    came back after a reload, and it left a running timer pointing into the
//    new list
//  - removing a topic before the running one shifted the index without
//    refreshing the bar/guests; editing the running topic's duration left the
//    countdown on the old length
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installTimerGlobals, loadTimerModule } from './harness.js';

loadTimerModule();

const T = (name, duration = 120, notes = '') => ({ name, duration, notes });
let broadcasts;
beforeEach(() => {
  vi.useFakeTimers();
  broadcasts = installTimerGlobals();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function seed(...topics) { timerQueue.push(...topics); }

describe('popout snapshot', () => {
  it('has no notes or topic once the timer is stopped', () => {
    seed(T('Intro', 60, '**hello**'));
    timerStartStop();
    expect(timerPopoutSnapshot().notesHtml).toContain('hello');
    timerStopAll();
    const s = timerPopoutSnapshot();
    expect(s.active).toBe(false);
    expect(s.notesHtml).toBe('');
    expect(timerNotesEl.innerHTML).toBe('');
  });

  it('removing the running topic stops the timer and clears its notes', () => {
    seed(T('A', 60, 'notes A'), T('B'));
    timerStartStop();
    timerRemoveTopic(0);
    const s = timerPopoutSnapshot();
    expect(s.active).toBe(false);
    expect(s.notesHtml).toBe('');
    expect(s.queue.map(t => t.name)).toEqual(['B']);
  });

  it('guest: a timer_update with active=false clears the notes too', () => {
    installTimerGlobals({ IS_HOST: false });
    applyTimerUpdate({ active: true, topicName: 'X', topicNotes: 'some notes', remaining: 30, total: 60, yellowAt: 20, redAt: 10 });
    expect(timerPopoutSnapshot().notesHtml).toContain('some notes');
    applyTimerUpdate({ active: false });
    expect(timerPopoutSnapshot().notesHtml).toBe('');
  });
});

describe('timerRemoveTopic', () => {
  it('removing an earlier topic keeps the running one running and refreshes bar + guests', () => {
    seed(T('A'), T('B'), T('C'));
    timerStartStop();
    timerSkip(); timerSkip();                     // now on C (index 2)
    broadcasts.length = 0;
    timerRemoveTopic(0);
    expect(timerState.topicIndex).toBe(1);
    expect(timerTopicEl.textContent).toBe('C');
    expect(broadcasts.at(-1)).toMatchObject({ type: 'timer_update', topicName: 'C' });
  });

  it('persists the removal', () => {
    seed(T('A'), T('B'));
    timerRemoveTopic(0);
    expect(JSON.parse(localStorage.getItem('podbooth:timer-queue')).map(t => t.name)).toEqual(['B']);
  });
});

describe('timerUpsertTopic', () => {
  it('editing the running topic\'s duration shifts the live countdown', () => {
    seed(T('A', 120));
    timerStartStop();
    timerState.remaining = 100;
    timerUpsertTopic(0, { name: 'A', duration: 180, notes: '' });
    expect(timerState.remaining).toBe(160);
    expect(timerState.total).toBe(180);
  });
});

describe('replaceTimerQueue (Outline sync)', () => {
  it('saves the new queue so a reload does not bring the old topics back', () => {
    seed(T('Old'));
    replaceTimerQueue([{ name: 'New 1', duration: 90, notes: 'n' }, { name: 'New 2', duration: 0 }]);
    const saved = JSON.parse(localStorage.getItem('podbooth:timer-queue'));
    expect(saved.map(t => t.name)).toEqual(['New 1', 'New 2']);
    expect(saved[1].duration).toBe(60);           // 0 ("no duration found") becomes the 60s default, same as on load
  });

  it('stops a running timer rather than leaving it pointing into the new list', () => {
    seed(T('Old A'), T('Old B'));
    timerStartStop();
    replaceTimerQueue([{ name: 'New', duration: 30, notes: '' }]);
    expect(timerState.active).toBe(false);
    expect(timerPopoutSnapshot().queue.map(t => t.name)).toEqual(['New']);
  });
});
