// 작품(height-map + color-map 한 쌍) 목록.
// - 관리자 인스펙터: 이미지 두 장을 올려 item 을 추가 / 삭제
// - 사용자 인스펙터: 목록에서 item 을 골라 렌더링
// 저장소는 ArtworkRepository 인터페이스 뒤에 숨겨 두었다. 지금은 브라우저 IndexedDB 구현만 있고,
// 나중에 관리자 페이지 + 서버 저장으로 바꿀 때는 이 인터페이스의 구현만 갈아끼우면 된다.

export interface Artwork {
  id: string;
  name: string;
  colorUrl: string;
  heightUrl: string;
  builtin: boolean; // 기본 제공 item (삭제 불가)
  createdAt: number;
}

/** 저장소에 들어가는 원본 레코드 (이미지는 Blob 그대로) */
export interface ArtworkRecord {
  id: string;
  name: string;
  color: Blob;
  height: Blob;
  createdAt: number;
}

export interface ArtworkRepository {
  list(): Promise<ArtworkRecord[]>;
  put(record: ArtworkRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export const DEFAULT_ARTWORK: Artwork = {
  id: "default",
  name: "기본 작품 (Impasto)",
  colorUrl: "/art/color.webp",
  heightUrl: "/art/height.webp",
  builtin: true,
  createdAt: 0,
};

// ───────────────────────────── IndexedDB 구현 ─────────────────────────────
const DB_NAME = "hmap-artworks";
const DB_VERSION = 1;
const STORE = "artworks";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export class IndexedDBArtworkRepository implements ArtworkRepository {
  private db?: Promise<IDBDatabase>;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  private async store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await this.open()).transaction(STORE, mode).objectStore(STORE);
  }

  async list(): Promise<ArtworkRecord[]> {
    const rows = await request((await this.store("readonly")).getAll() as IDBRequest<ArtworkRecord[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }

  async put(record: ArtworkRecord): Promise<void> {
    await request((await this.store("readwrite")).put(record));
  }

  async remove(id: string): Promise<void> {
    await request((await this.store("readwrite")).delete(id));
  }
}

// ───────────────────────────── 라이브러리 (UI 공유 상태) ─────────────────────────────
export interface ArtworkLibraryState {
  items: Artwork[]; // [기본 item, ...업로드 item]
  selectedId: string;
  loaded: boolean;
  error: string | null;
}

type Listener = () => void;

export class ArtworkLibrary {
  private state: ArtworkLibraryState = {
    items: [DEFAULT_ARTWORK],
    selectedId: DEFAULT_ARTWORK.id,
    loaded: false,
    error: null,
  };
  private listeners = new Set<Listener>();
  private loading?: Promise<void>;

  constructor(private repo: ArtworkRepository) {}

  get = (): ArtworkLibraryState => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private set(patch: Partial<ArtworkLibraryState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  selected(): Artwork {
    return this.state.items.find((a) => a.id === this.state.selectedId) ?? DEFAULT_ARTWORK;
  }

  /** 저장된 item 을 불러온다 (여러 번 불러도 한 번만 실행) */
  load(): Promise<void> {
    this.loading ??= this.repo
      .list()
      .then((records) => this.set({ items: [DEFAULT_ARTWORK, ...records.map(toArtwork)], loaded: true }))
      .catch((e: unknown) => this.set({ loaded: true, error: `저장된 작품을 불러오지 못했습니다: ${message(e)}` }));
    return this.loading;
  }

  select(id: string) {
    if (id === this.state.selectedId || !this.state.items.some((a) => a.id === id)) return;
    this.set({ selectedId: id });
  }

  async add(input: { name: string; color: Blob; height: Blob }): Promise<Artwork> {
    const record: ArtworkRecord = {
      id: crypto.randomUUID(),
      name: input.name.trim() || "제목 없음",
      color: input.color,
      height: input.height,
      createdAt: Date.now(),
    };
    await this.repo.put(record);
    const artwork = toArtwork(record);
    this.set({ items: [...this.state.items, artwork], error: null });
    return artwork;
  }

  async remove(id: string): Promise<void> {
    const target = this.state.items.find((a) => a.id === id);
    if (!target || target.builtin) return;
    await this.repo.remove(id);
    const items = this.state.items.filter((a) => a.id !== id);
    // 렌더링 중인 item 을 지우면 기본 item 으로 돌아간다
    const selectedId = this.state.selectedId === id ? DEFAULT_ARTWORK.id : this.state.selectedId;
    this.set({ items, selectedId });
    // 렌더러가 새 텍스처를 읽은 뒤에 URL 을 해제
    setTimeout(() => {
      URL.revokeObjectURL(target.colorUrl);
      URL.revokeObjectURL(target.heightUrl);
    }, 5000);
  }
}

function toArtwork(r: ArtworkRecord): Artwork {
  return {
    id: r.id,
    name: r.name,
    colorUrl: URL.createObjectURL(r.color),
    heightUrl: URL.createObjectURL(r.height),
    builtin: false,
    createdAt: r.createdAt,
  };
}

function message(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

let library: ArtworkLibrary | null = null;

/** 브라우저 전용 싱글턴 (SSR 에서는 호출하지 않는다) */
export function getArtworkLibrary(): ArtworkLibrary {
  library ??= new ArtworkLibrary(new IndexedDBArtworkRepository());
  return library;
}

const SERVER_STATE: ArtworkLibraryState = { items: [DEFAULT_ARTWORK], selectedId: DEFAULT_ARTWORK.id, loaded: false, error: null };
export const getServerArtworkState = () => SERVER_STATE;
