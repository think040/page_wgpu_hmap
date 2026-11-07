"use client";

import { useEffect, useSyncExternalStore } from "react";
import { getArtworkLibrary, getServerArtworkState, type ArtworkLibraryState } from "./artworks";

const subscribe = (cb: () => void) => getArtworkLibrary().subscribe(cb);
const getSnapshot = () => getArtworkLibrary().get();

/** 작품 목록 상태를 구독한다. 처음 마운트될 때 IndexedDB 에서 저장된 item 을 불러온다. */
export function useArtworks(): ArtworkLibraryState {
  useEffect(() => {
    void getArtworkLibrary().load();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerArtworkState);
}
