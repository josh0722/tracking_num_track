import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// 1. Promise.race safe-close 패턴 검증
//    context.close() / browser.close()에서 .catch()를 close() 프로미스에 직접
//    부착해야 race 패자의 reject가 unhandled가 되지 않는다.
// ---------------------------------------------------------------------------
describe('Promise.race safe close pattern', () => {
  let unhandledRejections: unknown[] = [];
  const handler = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.removeListener('unhandledRejection', handler);
    unhandledRejections = [];
  });

  it('should NOT produce unhandled rejection when close() rejects after timeout wins (fixed pattern)', async () => {
    process.on('unhandledRejection', handler);

    // 시뮬레이션: close()가 200ms 후 reject, timeout은 50ms 후 resolve
    const closePromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('close failed')), 200);
    });

    await Promise.race([
      closePromise.catch(() => undefined), // 수정된 패턴: close()에 직접 catch
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        t.unref();
      }),
    ]);

    // close() rejection이 발생할 시간 대기
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(unhandledRejections.length, 0, 'unhandled rejection이 발생하면 안 됨');
  });

  it('Promise.race internally handles losing promise rejection (no unhandled rejection)', async () => {
    // Promise.race는 내부적으로 모든 입력 프로미스에 .then(resolve, reject)를 부착하므로
    // 패자의 reject도 "handled"로 처리됨. 하지만 명시적 .catch()를 붙이면
    // 의도가 더 명확하고, Promise.race 없이 사용될 때도 안전.
    process.on('unhandledRejection', handler);

    const closePromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('close failed')), 200);
    });

    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 50);
        t.unref();
      }),
    ]).catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.equal(unhandledRejections.length, 0, 'Promise.race가 내부적으로 핸들링');
  });
});

// ---------------------------------------------------------------------------
// 2. 양쪽 프로미스에 catch 부착 (scrapeAccount + timeout race)
// ---------------------------------------------------------------------------
describe('Promise.race with both promises having catch', () => {
  let unhandledRejections: unknown[] = [];
  const handler = (reason: unknown) => {
    unhandledRejections.push(reason);
  };

  afterEach(() => {
    process.removeListener('unhandledRejection', handler);
    unhandledRejections = [];
  });

  it('should handle timeout winning when scrape later rejects', async () => {
    process.on('unhandledRejection', handler);

    const scrapePromise = new Promise<string[]>((_, reject) => {
      setTimeout(() => reject(new Error('scrape failed')), 200);
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 50);
      t.unref();
    });

    // 수정된 패턴: 양쪽 모두 catch
    scrapePromise.catch(() => undefined);
    timeoutPromise.catch(() => undefined);

    try {
      await Promise.race([scrapePromise, timeoutPromise]);
    } catch {
      // timeout이 이김 → 정상적으로 catch
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(unhandledRejections.length, 0);
  });

  it('should handle scrape winning when timeout later rejects', async () => {
    process.on('unhandledRejection', handler);

    const scrapePromise = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve(['row1']), 50);
    });
    const timeoutPromise = new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 200);
      t.unref();
    });

    scrapePromise.catch(() => undefined);
    timeoutPromise.catch(() => undefined);

    const result = await Promise.race([scrapePromise, timeoutPromise]);
    assert.deepEqual(result, ['row1']);

    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(unhandledRejections.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. 재시도 딜레이 검증
// ---------------------------------------------------------------------------
describe('retry delay calculation', () => {
  it('should produce increasing delays per attempt', () => {
    const delays = [1, 2].map((attempt) => attempt * 5_000);
    assert.deepEqual(delays, [5_000, 10_000]);
  });
});

// ---------------------------------------------------------------------------
// 4. unref()가 process exit을 방해하지 않는지 검증
// ---------------------------------------------------------------------------
describe('setTimeout.unref()', () => {
  it('unref timer should not prevent test completion', async () => {
    const start = Date.now();
    await Promise.race([
      new Promise<void>((resolve) => resolve()),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 60_000); // 1분 타이머
        t.unref(); // unref 있으므로 즉시 진행 가능
      }),
    ]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 1_000, 'unref 타이머가 blocking하면 안 됨');
  });
});
