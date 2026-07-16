import {describe, expect, it} from 'vitest';

import {parseStartupOptions} from '../src/main/startup.js';

describe('parseStartupOptions', () => {
  it('parses separated and equal listen-address values in order', () => {
    expect(
      parseStartupOptions([
        '--listen-address',
        '/ip4/127.0.0.1/tcp/4001',
        '--listen-address=/ip6/::1/tcp/4002',
      ]),
    ).toEqual({
      listenAddresses: [
        '/ip4/127.0.0.1/tcp/4001',
        '/ip6/::1/tcp/4002',
      ],
    });
  });

  it('parses relay-only', () => {
    expect(parseStartupOptions(['--relay-only'])).toEqual({relayOnly: true});
  });

  it('ignores unrelated Electron and Chromium arguments', () => {
    expect(
      parseStartupOptions([
        '/path/to/app',
        '--inspect=9229',
        '--disable-gpu',
        '--',
      ]),
    ).toEqual({});
  });

  it.each([
    ['missing value', ['--listen-address']],
    ['empty equal value', ['--listen-address=']],
    ['following option', ['--listen-address', '--disable-gpu']],
  ])('rejects a %s', (_name, args) => {
    expect(() => parseStartupOptions(args)).toThrow(
      '--listen-address requires a non-empty multiaddr',
    );
  });

  it('rejects relay-only combined with an explicit listen address', () => {
    expect(() =>
      parseStartupOptions([
        '--relay-only',
        '--listen-address=/ip4/127.0.0.1/tcp/4001',
      ]),
    ).toThrow('--relay-only cannot be combined with --listen-address');
  });
});
