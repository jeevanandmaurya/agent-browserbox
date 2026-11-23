import { describe, expect, it } from 'vitest';
import { toWire } from '../packages/agent/src/providers/openai';
import type { Msg } from '../packages/agent/src/types';

describe('images on the OpenAI protocol', () => {
  it('sends attached images as image_url parts, and tool images as a following user message', () => {
    const msgs: Msg[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', path: '/a.png', mediaType: 'image/png', data: 'QUJD' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'view_image', input: { path: 'b.jpg' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Showing /b.jpg.', images: [{ path: '/b.jpg', mediaType: 'image/jpeg', data: 'REVG' }] }] },
    ];
    const wire = toWire('sys', msgs);
    expect(wire[1]).toEqual({ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }] });
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: 't', content: 'Showing /b.jpg.' });
    expect(wire[4]).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,REVG' } }] });
  });
});
