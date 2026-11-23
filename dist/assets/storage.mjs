const databaseName = "upc-attendance-v1";
const storeName = "workspaces";

let connection;

function database() {
  return connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(storeName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("请关闭其他报备页面，再重新打开。"));
  });
}

async function readRecord(db, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(storeName).objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readWorkspace(key) {
  return readRecord(await database(), key);
}

export function openTemporaryWorkspace(seed) {
  let value = seed();
  return {
    async read() {
      return structuredClone(value);
    },
    async edit(update) {
      const draft = structuredClone(value);
      update(draft);
      value = draft;
      return structuredClone(draft);
    },
  };
}

export async function openWorkspace(key, seed) {
  const db = await database();

  function edit(update) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, "readwrite");
      const store = tx.objectStore(storeName);
      const request = store.get(key);
      let value;
      let error;
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(error || tx.error || new Error("保存失败。"));
      request.onsuccess = () => {
        try {
          value = request.result ?? seed();
          update(value);
          store.put(value, key);
        } catch (failure) {
          error = failure;
          tx.abort();
        }
      };
    });
  }

  async function read() {
    return (await readRecord(db, key)) ?? seed();
  }

  await edit(() => {});
  return {edit, read};
}
