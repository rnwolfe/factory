/**
 * Bun test preload — installs happy-dom globals so React components can
 * render and @testing-library/react can query the DOM.
 *
 * Referenced from apps/pwa/bunfig.toml [test].preload.
 */

// biome-ignore lint/suspicious/noExplicitAny: type-safe DOM globals can't be wired without 'any'
type G = Record<string, any>;

// Lazy-import happy-dom so the module only loads for test files.
// The preload runs once per test worker, so this is cheap.
const { Window } = await import("happy-dom");

const happyWindow = new Window({ url: "http://localhost/" });
const g = global as G;

g.window = happyWindow;
g.document = happyWindow.document;
g.navigator = happyWindow.navigator;
g.location = happyWindow.location;
g.history = happyWindow.history;
g.HTMLElement = happyWindow.HTMLElement;
g.SVGElement = happyWindow.SVGElement;
g.Element = happyWindow.Element;
g.Node = happyWindow.Node;
g.NodeList = happyWindow.NodeList;
g.Text = happyWindow.Text;
g.Comment = happyWindow.Comment;
g.DocumentFragment = happyWindow.DocumentFragment;
g.Event = happyWindow.Event;
g.CustomEvent = happyWindow.CustomEvent;
g.MutationObserver = happyWindow.MutationObserver;
g.ResizeObserver = happyWindow.ResizeObserver;
g.requestAnimationFrame = (cb: FrameRequestCallback) => happyWindow.requestAnimationFrame(cb);
g.cancelAnimationFrame = (id: number) =>
  happyWindow.cancelAnimationFrame(id as unknown as ReturnType<typeof setTimeout>);
g.getComputedStyle = (...args: unknown[]) =>
  happyWindow.getComputedStyle(...(args as Parameters<typeof happyWindow.getComputedStyle>));
g.localStorage = happyWindow.localStorage;
g.sessionStorage = happyWindow.sessionStorage;
