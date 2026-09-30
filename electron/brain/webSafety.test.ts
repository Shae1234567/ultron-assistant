import { describe, expect, it } from 'vitest';
import { judgeClick, judgeKeys, judgeSubmit, judgeTyping, looksLikeCardNumber } from './webSafety';
import type { Target } from '../browser';

const t = (over: Partial<Target>): Target => ({
  tag: 'button', type: '', role: '', text: '', label: '', formButtons: [], sensitive: false, editable: false, url: 'https://example.com/x', host: 'example.com', ...over,
});

describe('web safety', () => {
  it('never buys, pays, subscribes or creates accounts', () => {
    for (const text of ['Buy now', 'Place your order', 'Subscribe', 'Add to cart', 'Start free trial', 'Upgrade']) expect(judgeClick(t({ text })).kind, text).toBe('block');
    expect(judgeClick(t({ text: 'Sign up' })).kind).toBe('block');
    expect(judgeClick(t({ text: 'Create account' })).kind).toBe('block');
  });

  it('asks before posting, sending, sharing, deleting or confirming', () => {
    for (const text of ['Post', 'Publish', 'Send', 'Share', 'Reply', 'Delete', 'Move to trash', 'Confirm', 'I agree']) expect(judgeClick(t({ text })).kind, text).toBe('ask');
  });

  it('lets ordinary building clicks through', () => {
    for (const text of ['Create a design', 'New document', 'Blank page', 'Text', 'Bold', 'Sign in', 'Log in', 'Next', 'Home']) expect(judgeClick(t({ text })).kind, text).toBe('allow');
  });

  it('never types into password or card fields, or types card numbers', () => {
    expect(judgeTyping(t({ tag: 'input', type: 'password', sensitive: true }), 'hunter2').kind).toBe('block');
    expect(judgeTyping(t({ tag: 'input' }), '4242 4242 4242 4242').kind).toBe('block');
    expect(judgeTyping(t({ tag: 'input' }), 'My Mongol Empire poster').kind).toBe('allow');
    expect(looksLikeCardNumber('call 403-555-0199 about room 12')).toBe(false);
  });

  it('treats Enter in a message box as sending, but not in a search box or a document', () => {
    expect(judgeSubmit(t({ tag: 'div', role: 'textbox', label: 'Message #general', editable: true })).kind).toBe('ask');
    expect(judgeSubmit(t({ tag: 'input', type: 'search', label: 'Search' })).kind).toBe('allow');
    expect(judgeSubmit(t({ tag: 'div', role: 'textbox', label: '', editable: true })).kind).toBe('allow');
    expect(judgeSubmit(t({ tag: 'input', label: 'Email', formButtons: ['Subscribe'] })).kind).toBe('block');
  });

  it('asks before Delete acts on a selected item, not while editing text', () => {
    expect(judgeKeys('Delete', t({ tag: 'tr', text: 'Invoice from school' })).kind).toBe('ask');
    expect(judgeKeys('Backspace', t({ tag: 'div', editable: true })).kind).toBe('allow');
    expect(judgeKeys('Control+Enter', t({ tag: 'div', role: 'textbox', label: 'Reply', editable: true })).kind).toBe('ask');
  });
});
