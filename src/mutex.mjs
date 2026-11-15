// 道具を 1 本ずつ通す鍵。先に頼んだ順に動く。
export class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const result = this.#tail.then(() => fn());
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
