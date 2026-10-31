import { test } from 'node:test';

// The interval keeps the loop alive: with nothing pending, Node's runner would end the test itself.
test('awaits a promise that never settles', () => new Promise(() => setInterval(() => {}, 1 << 30)));
