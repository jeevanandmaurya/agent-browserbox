/**
 * Components the agent can put in a chat reply: a fenced ```ui block in a
 * small line-based language (a subset of OpenUI Lang, https://www.openui.com):
 *
 *     root = Card("Pick a plan", [choice, go])
 *     choice = Choices("plan", "Plan", ["Basic", "Pro"])
 *     go = Button("Continue", @ToAssistant("Go on with the chosen plan"))
 *
 * One statement per line (`name = expression`), `root` first so the frame
 * shows while the rest streams in; arguments are positional, in the order
 * below. The host renders the block; this list is the single source of what
 * exists, for the prompt and for the renderer.
 */
export interface UiComponentSpec {
  name: string;
  /** Arguments in order; `?` marks optional ones. */
  args: string[];
  description: string;
}

export const UI_COMPONENTS: UiComponentSpec[] = [
  { name: 'Stack', args: ['children: Node[]', 'direction?: "column" | "row"'], description: 'Lays children out in a column (default) or a wrapping row.' },
  { name: 'Card', args: ['title: string', 'children: Node[]'], description: 'A titled box around related content.' },
  { name: 'Text', args: ['text: string', 'style?: "body" | "title" | "muted" | "small"'], description: 'A paragraph (inline Markdown: **bold**, `code`, links).' },
  { name: 'Callout', args: ['text: string', 'tone?: "info" | "ok" | "warn" | "error"'], description: 'A highlighted note.' },
  { name: 'Stats', args: ['stats: Stat[]'], description: 'A row of key figures.' },
  { name: 'Stat', args: ['label: string', 'value: string | number', 'change?: string'], description: 'One figure, e.g. Stat("Revenue", "$12k", "+8%").' },
  { name: 'Table', args: ['columns: string[]', 'rows: (string | number)[][]'], description: 'A table; the user can sort it by a column.' },
  { name: 'Chart', args: ['kind: "bar" | "line" | "pie"', 'labels: string[]', 'series: Series[] | number[]', 'title?: string'], description: 'A small chart.' },
  { name: 'Series', args: ['name: string', 'values: number[]'], description: 'One data series of a Chart.' },
  { name: 'Progress', args: ['label: string', 'value: number', 'max?: number'], description: 'A progress bar (default max 100).' },
  { name: 'Checklist', args: ['items: (string | Item)[]'], description: 'A list of steps with ticks.' },
  { name: 'Item', args: ['text: string', 'done?: boolean'], description: 'One Checklist entry.' },
  { name: 'Buttons', args: ['buttons: Button[]'], description: 'A row of buttons.' },
  { name: 'Button', args: ['label: string', 'action: Action', 'style?: "primary" | "secondary"'], description: 'A button that runs an action.' },
  { name: 'Choices', args: ['id: string', 'label: string', 'options: string[]', 'multiple?: boolean'], description: 'Options as chips. Inside a Form it is a field; on its own, a click sends the choice as the user’s reply.' },
  { name: 'Form', args: ['id: string', 'fields: Node[]', 'submit?: string'], description: 'Fields with a submit button; submitting sends every value as the user’s reply.' },
  { name: 'Input', args: ['id: string', 'label: string', 'placeholder?: string', 'kind?: "text" | "number" | "email" | "date" | "time" | "textarea"'], description: 'A text field (inside a Form).' },
  { name: 'Select', args: ['id: string', 'label: string', 'options: string[]'], description: 'A drop-down (inside a Form).' },
  { name: 'Checkbox', args: ['id: string', 'label: string', 'checked?: boolean'], description: 'A tick box (inside a Form).' },
  { name: 'Slider', args: ['id: string', 'label: string', 'min: number', 'max: number', 'value?: number'], description: 'A range (inside a Form).' },
  { name: 'Link', args: ['label: string', 'target: string'], description: 'Opens a web address, or a file or folder of the box (an .html file opens in Preview).' },
  { name: 'Image', args: ['src: string', 'alt: string'], description: 'A picture: a box path (e.g. /tmp/chart.png) or an https address.' },
  { name: 'Code', args: ['text: string', 'language?: string'], description: 'A block of code.' },
  { name: 'Divider', args: [], description: 'A horizontal rule.' },
];

/** Actions a Button (or Link) can run. */
export const UI_ACTIONS = [
  { name: '@ToAssistant', args: ['message: string'], description: 'sends the message as the user’s reply' },
  { name: '@OpenUrl', args: ['url: string'], description: 'opens a web page in a new tab' },
  { name: '@Open', args: ['target: string'], description: 'opens a file, folder or app of the box' },
];

/** The prompt section that teaches the language and the components. */
export function uiPrompt(): string {
  const sig = (c: { name: string; args: string[] }) => `${c.name}(${c.args.join(', ')})`;
  return `# Interactive replies
The chat window can show UI inside your reply: buttons, choices, forms, tables, charts, figures. Use it when it helps the user act or see something (pick between options, fill in details, compare numbers, follow progress), not for ordinary prose. Write a fenced block with the language \`ui\`, around normal Markdown text:

\`\`\`ui
root = Card("Which database?", [pick, note])
pick = Choices("db", "Database", ["SQLite", "Postgres"])
note = Text("SQLite needs no server.", "muted")
\`\`\`

Rules: one statement per line, \`name = expression\`; start with \`root = …\`, then define each name it uses (they render as they arrive). Expressions: Component(args…) with arguments in the order below, "strings", numbers, true/false, [arrays], and names defined in the block. Clicks and submitted forms come back to you as the user's next message.
Components:
${UI_COMPONENTS.map((c) => `- ${sig(c)} — ${c.description}`).join('\n')}
Actions (for Button): ${UI_ACTIONS.map((a) => `${sig(a)} ${a.description}`).join('; ')}.`;
}
