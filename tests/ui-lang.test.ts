import { describe, expect, it } from 'vitest';
import { parseUi } from '../apps/browserbox/src/apps/agent/ui-lang';
import { UI_COMPONENTS } from '../packages/agent/src/ui-spec';
import { RENDERED } from '../apps/browserbox/src/apps/agent/ui-names';

describe('ui blocks', () => {
  it('reads statements, calls, arrays, refs and actions', () => {
    const p = parseUi(`root = Card("Pick", [choice, go])
choice = Choices("plan", "Plan", ["Basic", "Pro"], false)
go = Button("Continue", @ToAssistant("Go on"), "primary")`);
    expect(p.errors).toEqual([]);
    expect(p.root).toBe('root');
    expect(p.defs.get('root')).toEqual({ t: 'call', name: 'Card', args: [{ t: 'str', v: 'Pick' }, { t: 'arr', items: [{ t: 'ref', name: 'choice' }, { t: 'ref', name: 'go' }] }] });
    expect(p.defs.get('go')).toMatchObject({ t: 'call', name: 'Button', args: [{ t: 'str' }, { t: 'action', name: '@ToAssistant', args: [{ t: 'str', v: 'Go on' }] }, { t: 'str', v: 'primary' }] });
  });

  it('reads OpenUI Lang examples from its docs', () => {
    const p = parseUi(`root = Stack([title])
title = TextContent("Hello", "large-heavy")
$days = "7"
submitBtn = Button("Create", Action([@Run(createResult), @Run(tickets), @Reset($title)]))`);
    expect(p.errors).toEqual([]);
    expect([...p.defs.keys()]).toEqual(['root', 'title', '$days', 'submitBtn']);
  });

  it('joins statements over lines while brackets are open, and skips comments', () => {
    const p = parseUi(`# a table
root = Table(["Region", "Sales"], [
  ["West", 30],
  ["East", -1.5e2],
])`);
    expect(p.errors).toEqual([]);
    expect(p.defs.get('root')).toMatchObject({ t: 'call', args: [{ t: 'arr' }, { t: 'arr', items: [{ t: 'arr' }, { t: 'arr', items: [{ t: 'str', v: 'East' }, { t: 'num', v: -150 }] }] }] });
  });

  it('while streaming, leaves out the half-written last line; bad lines are skipped, not fatal', () => {
    const p = parseUi(`root = Stack([a, b])\na = Text("ok")\nb = Text("half`, false);
    expect([...p.defs.keys()]).toEqual(['root', 'a']);
    const q = parseUi(`root = Stack([a])\noops = Text("x" "y")\na = Text("fine")`);
    expect([...q.defs.keys()]).toEqual(['root', 'a']);
    expect(q.errors[0]).toMatch(/oops/);
  });

  it('the renderer draws every component the agent is told about', () => {
    expect(UI_COMPONENTS.map((c) => c.name).filter((n) => !RENDERED.includes(n))).toEqual([]);
  });
});
