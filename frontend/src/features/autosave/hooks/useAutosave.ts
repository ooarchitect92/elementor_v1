import { useEffect, useRef, useState, useCallback } from "react";
import type { AutosaveStatus } from "../types/autosave.types";
import type { EditorElement } from "../../../pages/editor/WebsiteEditor";
import type { PageSettingsData } from "../../revision-history/types/revisionHistory.types";

interface UseAutosaveParams {
  websiteId: string | undefined;
  elements: EditorElement[];
  pageSettings: PageSettingsData;
  apiUrl: string;
  isLoadingWebsite: boolean;
  debounceMs?: number;
}

interface SavePayload {
  snapshot: string;
  elements: EditorElement[];
  pageSettings: PageSettingsData;
  requestKey: string;
}

function requestKey(websiteId: string) {
  const id = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `autosave:${websiteId}:${id}`;
}

export function useAutosave({
  websiteId,
  elements,
  pageSettings,
  apiUrl,
  isLoadingWebsite,
  debounceMs = 1500,
}: UseAutosaveParams) {
  const [status, setStatus] = useState<AutosaveStatus>("saved");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const baselineRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);
  const queuedPayloadRef = useRef<SavePayload | null>(null);
  const revisionRef = useRef<number | null>(null);
  const revisionPromiseRef = useRef<Promise<number> | null>(null);

  const latestPropsRef = useRef({ websiteId, elements, pageSettings, apiUrl });
  useEffect(() => {
    latestPropsRef.current = { websiteId, elements, pageSettings, apiUrl };
  }, [websiteId, elements, pageSettings, apiUrl]);

  useEffect(() => {
    revisionRef.current = null;
    revisionPromiseRef.current = null;
  }, [websiteId]);

  const serializeState = useCallback((currentElements: EditorElement[], currentPageSettings: PageSettingsData): string => {
    try {
      return JSON.stringify({ elements: currentElements || [], pageSettings: currentPageSettings || {} });
    } catch (err) {
      console.error("Failed to serialize editor state for autosave:", err);
      return "";
    }
  }, []);

  const fetchCurrentRevision = useCallback(async (): Promise<number> => {
    const { websiteId: currentWebId, apiUrl: currentApiUrl } = latestPropsRef.current;
    if (!currentWebId) throw new Error("Website is not available for autosave.");
    if (revisionRef.current !== null) return revisionRef.current;
    if (revisionPromiseRef.current) return revisionPromiseRef.current;

    revisionPromiseRef.current = (async () => {
      const response = await fetch(`${currentApiUrl}/api/v2/websites/${currentWebId}/editor-state`, {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || data?.message || "Failed to load server revision.");
      const revision = Number(data?.website?.currentRevision);
      if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Server returned an invalid editor revision.");
      revisionRef.current = revision;
      return revision;
    })();

    try {
      return await revisionPromiseRef.current;
    } finally {
      revisionPromiseRef.current = null;
    }
  }, []);

  const updateBaseline = useCallback((newElements: EditorElement[], newPageSettings?: PageSettingsData) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    queuedPayloadRef.current = null;
    baselineRef.current = serializeState(newElements, newPageSettings || {});
    isInitializedRef.current = true;
    setStatus("saved");
    setLastSavedAt(Date.now());
    setErrorMessage(null);
    // A manual save may have advanced the server revision. Refresh lazily before the next autosave.
    revisionRef.current = null;
  }, [serializeState]);

  const performSave = useCallback(async (payload: SavePayload) => {
    const { websiteId: currentWebId, apiUrl: currentApiUrl } = latestPropsRef.current;
    if (!currentWebId || !payload?.snapshot) {
      isSavingRef.current = false;
      return;
    }

    try {
      isSavingRef.current = true;
      setStatus("saving");
      setErrorMessage(null);
      const expectedRevision = await fetchCurrentRevision();
      const bodyPayload = {
        expectedRevision,
        requestKey: payload.requestKey,
        editorData: {
          version: 1,
          elements: payload.elements,
          pageSettings: payload.pageSettings,
        },
      };

      const res = await fetch(`${currentApiUrl}/api/v2/websites/${currentWebId}/editor-state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify(bodyPayload),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data?.error?.code === "REVISION_CONFLICT") {
          revisionRef.current = null;
          throw new Error("This website changed on the server. Reload or resolve the conflict before saving again.");
        }
        throw new Error(data?.error?.message || data?.message || "Failed to autosave website.");
      }

      const persistedRevision = Number(data?.save?.revision);
      if (!data?.save?.persisted || !Number.isSafeInteger(persistedRevision)) {
        throw new Error("Server did not return a durable save receipt.");
      }
      revisionRef.current = persistedRevision;
      baselineRef.current = payload.snapshot;
      setLastSavedAt(Date.now());
      isSavingRef.current = false;

      if (queuedPayloadRef.current) {
        const nextPayload = queuedPayloadRef.current;
        queuedPayloadRef.current = null;
        void performSave(nextPayload);
      } else {
        const currentLiveSnapshot = serializeState(latestPropsRef.current.elements, latestPropsRef.current.pageSettings);
        setStatus(currentLiveSnapshot !== baselineRef.current ? "unsaved" : "saved");
      }
    } catch (err: any) {
      isSavingRef.current = false;
      queuedPayloadRef.current = null;
      console.error("Autosave error:", err);
      setStatus("error");
      setErrorMessage(err.message || "Autosave failed.");
    }
  }, [fetchCurrentRevision, serializeState]);

  useEffect(() => {
    if (isLoadingWebsite || !websiteId) return;
    if (!isInitializedRef.current || baselineRef.current === null) {
      baselineRef.current = serializeState(elements, pageSettings);
      isInitializedRef.current = true;
      setStatus("saved");
      void fetchCurrentRevision().catch((error) => {
        console.error("Failed to initialize durable autosave revision:", error);
        setStatus("error");
        setErrorMessage(error.message || "Failed to initialize autosave.");
      });
    }
  }, [isLoadingWebsite, websiteId, elements, pageSettings, serializeState, fetchCurrentRevision]);

  useEffect(() => {
    if (isLoadingWebsite || !websiteId || !isInitializedRef.current || baselineRef.current === null) return;
    const currentSnapshot = serializeState(elements, pageSettings);
    if (currentSnapshot === baselineRef.current) {
      if (status !== "saving" && status !== "saved") setStatus("saved");
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    setStatus("unsaved");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const snapshotToSave = serializeState(latestPropsRef.current.elements, latestPropsRef.current.pageSettings);
      if (snapshotToSave === baselineRef.current) return;
      const currentWebsiteId = latestPropsRef.current.websiteId;
      if (!currentWebsiteId) return;
      const payloadToSave: SavePayload = {
        snapshot: snapshotToSave,
        elements: JSON.parse(JSON.stringify(latestPropsRef.current.elements)),
        pageSettings: JSON.parse(JSON.stringify(latestPropsRef.current.pageSettings)),
        requestKey: requestKey(currentWebsiteId),
      };
      if (isSavingRef.current) queuedPayloadRef.current = payloadToSave;
      else void performSave(payloadToSave);
    }, debounceMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [elements, pageSettings, websiteId, isLoadingWebsite, debounceMs, serializeState, performSave, status]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return {
    status,
    lastSavedAt,
    errorMessage,
    isDirty: status === "unsaved" || status === "saving",
    updateBaseline,
  };
}
