import { IonContent, IonIcon, IonPage } from "@ionic/react";
import {
  MILESTONE_PRESETS,
  UPLOAD_MAX_FILES_PER_SESSION,
  type UploadDetails,
} from "@tinyglow/shared";
import { cameraOutline, chevronDown, cloudUploadOutline, imagesOutline } from "ionicons/icons";
import { type DragEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../auth/AuthProvider";
import { AppHeader } from "../components/AppHeader";
import { PushPrimer } from "../components/PushPrimer";
import { UploadRow } from "../components/UploadRow";
import {
  Button,
  Card,
  EmptyState,
  Message,
  SelectField,
  TextAreaField,
  TextField,
} from "../components/ui";
import { t } from "../i18n";
import { useGoogleConnection } from "../lib/googleImport";
import { hapticSuccess } from "../lib/haptics";
import { usePhotosInvalidation } from "../lib/queries";
import { useAppleSyncAvailable } from "../lib/queries/imports";
import { clearResumableUpload, hasResumableUpload, uploadManager } from "../lib/upload/manager";
import { useUploadItems } from "../lib/upload/useUploads";
import { FILE_ACCEPT } from "../lib/upload/validate";
import type { PickOutcome } from "../platform/native/picker";
import { isNative, nativePlatform } from "../platform/platform";

// Album sync (iPhone, admins): its own lazy chunk, so the web bundle carries no native code.
const GoogleCard = lazy(() =>
  import("../components/import/GoogleCard").then((m) => ({ default: m.GoogleCard })),
);
const SyncCard = lazy(() =>
  import("../components/import/SyncCard").then((m) => ({ default: m.SyncCard })),
);

interface DetailsForm {
  milestoneId: string;
  people: string[];
  note: string;
  locationLabel: string;
}
const EMPTY_DETAILS: DetailsForm = { milestoneId: "", people: [], note: "", locationLabel: "" };

function toDetails(f: DetailsForm): UploadDetails | undefined {
  const d: UploadDetails = {};
  if (f.milestoneId) d.milestoneId = f.milestoneId;
  if (f.people.length > 0) d.people = f.people;
  if (f.note.trim()) d.note = f.note.trim();
  if (f.locationLabel.trim()) d.locationLabel = f.locationLabel.trim();
  return Object.keys(d).length > 0 ? d : undefined;
}

function DetailsPanel({
  value,
  onChange,
}: {
  value: DetailsForm;
  onChange: (v: DetailsForm) => void;
}) {
  const [person, setPerson] = useState("");
  const addPerson = () => {
    const name = person.trim().slice(0, 60);
    if (name && !value.people.includes(name) && value.people.length < 20) {
      onChange({ ...value, people: [...value.people, name] });
    }
    setPerson("");
  };
  return (
    <div className="ll-card flex flex-col gap-4" data-testid="upload-details">
      <p className="ll-hint">{t("upload.detailsHint")}</p>
      <SelectField
        id="upload-milestone"
        label={t("upload.milestone")}
        data-testid="upload-milestone"
        value={value.milestoneId}
        onChange={(e) => onChange({ ...value, milestoneId: e.target.value })}
      >
        <option value="">{t("upload.milestoneNone")}</option>
        {MILESTONE_PRESETS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </SelectField>
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <TextField
              label={t("upload.people")}
              data-testid="upload-people-input"
              value={person}
              maxLength={60}
              onChange={(e) => setPerson(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addPerson();
                }
              }}
            />
          </div>
          <Button variant="secondary" onClick={addPerson} data-testid="upload-people-add">
            {t("upload.peopleAdd")}
          </Button>
        </div>
        {value.people.length > 0 ? (
          <ul className="ll-chips">
            {value.people.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="ll-chip"
                  aria-label={t("upload.peopleRemove", { name })}
                  onClick={() =>
                    onChange({ ...value, people: value.people.filter((p) => p !== name) })
                  }
                >
                  {name}
                  <span aria-hidden className="ll-chip-x">
                    &times;
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <TextAreaField
        id="upload-note"
        label={t("upload.note")}
        data-testid="upload-note"
        rows={3}
        maxLength={2000}
        value={value.note}
        onChange={(e) => onChange({ ...value, note: e.target.value })}
      />
      <TextField
        label={t("upload.location")}
        data-testid="upload-location"
        maxLength={120}
        value={value.locationLabel}
        onChange={(e) => onChange({ ...value, locationLabel: e.target.value })}
      />
    </div>
  );
}

export function UploadPage() {
  const navigate = useNavigate();
  const { baby } = useCurrentBaby();
  const babyId = baby?.id;
  const { items, summary } = useUploadItems(babyId);
  usePhotosInvalidation();

  const inputRef = useRef<HTMLInputElement>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [showDetails, setShowDetails] = useState(false);
  const [form, setForm] = useState<DetailsForm>(EMPTY_DETAILS);
  const native = isNative();
  // Native has no "choose the same photos" step: re-picking is safe because the server skips
  // photos it already holds (SHA-256), and the picker copies are gone after a restart anyway.
  const [resumable, setResumable] = useState(
    () => !native && (babyId ? hasResumableUpload(babyId) : false),
  );
  const [pickBusy, setPickBusy] = useState(false);
  const [pickMessage, setPickMessage] = useState<string | null>(null);
  const [tooMany, setTooMany] = useState(false);

  const isContributor = baby?.role === "contributor";
  const appleSync = useAppleSyncAvailable();
  const googleImport =
    useGoogleConnection(baby?.role === "admin" || baby?.role === "contributor").data?.available ===
    true;
  const retryableCount = items.filter((i) => i.state === "failed" && i.retryable).length;
  const finishedCount = items.filter(
    (i) =>
      ["ingested", "duplicate", "aborted"].includes(i.state) ||
      (i.state === "failed" && !i.retryable),
  ).length;

  const addFiles = (list: FileList | File[] | null) => {
    if (!babyId || !list) return;
    const files = Array.from(list);
    if (files.length === 0) return;
    setTooMany(files.length > UPLOAD_MAX_FILES_PER_SESSION);
    uploadManager.add(babyId, files, toDetails(form));
  };

  const addNativeOutcome = (out: PickOutcome, source: "library" | "camera") => {
    if (out.status === "denied") {
      setPickMessage(
        t(source === "camera" ? "native.upload.cameraDenied" : "native.upload.denied"),
      );
    } else if (out.status === "error") {
      setPickMessage(t("native.upload.pickError"));
    } else if (out.status === "picked" && babyId) {
      setPickMessage(out.failed > 0 ? t("native.upload.skipped", { n: out.failed }) : null);
      setTooMany(false);
      if (out.files.length > 0) uploadManager.addNative(babyId, out.files, toDetails(form));
    }
  };

  const pickNative = async (source: "library" | "camera") => {
    if (!babyId || pickBusy) return;
    setPickBusy(true);
    setPickMessage(null);
    try {
      const picker = await import("../platform/native/picker");
      addNativeOutcome(
        source === "camera" ? await picker.takePhoto() : await picker.pickPhotos(),
        source,
      );
    } finally {
      setPickBusy(false);
    }
  };

  // A light tap when a batch finishes (app only).
  const wasActive = useRef(false);
  useEffect(() => {
    if (summary.active > 0) wasActive.current = true;
    else if (wasActive.current) {
      wasActive.current = false;
      if (summary.uploaded > 0) hapticSuccess();
    }
  }, [summary.active, summary.uploaded]);

  const resumeFiles = (list: FileList | null) => {
    if (!babyId || !list || list.length === 0) return;
    setResumable(false);
    void uploadManager.resume(babyId, Array.from(list), toDetails(form));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const summaryText = [
    t("upload.summaryUploaded", { n: summary.uploaded }),
    t("upload.summaryFailed", { n: summary.failed }),
    t(summary.duplicates === 1 ? "upload.summaryDuplicateOne" : "upload.summaryDuplicateOther", {
      n: summary.duplicates,
    }),
  ].join(", ");

  return (
    <IonPage>
      <AppHeader title={t("upload.title")} />
      <IonContent>
        {/* Whole content area is the drop zone (pointer devices); touch users use the picker. */}
        <section
          aria-label={t("upload.title")}
          data-testid="upload-dropzone"
          data-dragging={dragging ? "true" : "false"}
          className={`min-h-full p-4 ${dragging ? "bg-accent-tint outline-2 -outline-offset-8 outline-dashed outline-accent" : ""}`}
          onDragEnter={(e) => {
            e.preventDefault();
            dragDepth.current++;
            setDragging(true);
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragging(false);
          }}
          onDrop={onDrop}
        >
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
            {!baby ? (
              <EmptyState
                icon={cloudUploadOutline}
                action={
                  <Button onClick={() => navigate("/onboarding/baby?another=1")}>
                    {t("header.addBaby")}
                  </Button>
                }
              >
                {t("upload.noBaby")}
              </EmptyState>
            ) : (
              <>
                {native ? null : (
                  <>
                    <input
                      ref={inputRef}
                      data-testid="upload-input"
                      type="file"
                      multiple
                      accept={FILE_ACCEPT}
                      className="sr-only"
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={(e) => {
                        addFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <input
                      ref={resumeInputRef}
                      data-testid="upload-resume-input"
                      type="file"
                      multiple
                      accept={FILE_ACCEPT}
                      className="sr-only"
                      tabIndex={-1}
                      aria-hidden="true"
                      onChange={(e) => {
                        resumeFiles(e.target.files);
                        e.target.value = "";
                      }}
                    />
                  </>
                )}

                {resumable ? (
                  <Card className="flex flex-col gap-2" data-testid="upload-resume">
                    <h2 className="font-semibold">{t("upload.resumeTitle")}</h2>
                    <p className="text-sm text-muted">{t("upload.resumeBody")}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => resumeInputRef.current?.click()}>
                        {t("upload.resumeChoose")}
                      </Button>
                      <Button
                        variant="link"
                        size="sm"
                        onClick={() => {
                          clearResumableUpload(baby.id);
                          setResumable(false);
                        }}
                      >
                        {t("upload.resumeDiscard")}
                      </Button>
                    </div>
                  </Card>
                ) : null}

                <div className="ll-card flex flex-col items-center gap-3 px-4 py-8 text-center">
                  <span
                    aria-hidden
                    className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-tint text-accent-text"
                  >
                    <IonIcon icon={imagesOutline} className="h-7 w-7" />
                  </span>
                  {native ? (
                    <>
                      <div className="flex w-full max-w-xs flex-col gap-3">
                        <Button
                          variant={summary.uploaded > 0 ? "secondary" : "primary"}
                          data-testid="upload-choose"
                          disabled={pickBusy}
                          onClick={() => void pickNative("library")}
                        >
                          {t("native.upload.choose")}
                        </Button>
                        <Button
                          variant="secondary"
                          data-testid="upload-camera"
                          disabled={pickBusy}
                          onClick={() => void pickNative("camera")}
                        >
                          <IonIcon aria-hidden icon={cameraOutline} className="h-5 w-5" />
                          {t("native.upload.camera")}
                        </Button>
                      </div>
                      <p className="text-sm text-muted">{t("native.upload.primer")}</p>
                      <p className="text-sm text-muted">{t("upload.limitHint")}</p>
                      <p className="text-sm text-muted" data-testid="upload-background-note">
                        {t("native.upload.background")}
                      </p>
                      {nativePlatform() === "android" ? (
                        <p className="text-sm text-muted" data-testid="upload-android-note">
                          {t("native.upload.androidNote")}
                        </p>
                      ) : null}
                      {pickMessage ? (
                        <Message data-testid="upload-pick-error">{pickMessage}</Message>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Button
                        variant={summary.uploaded > 0 ? "secondary" : "primary"}
                        data-testid="upload-choose"
                        onClick={() => inputRef.current?.click()}
                      >
                        {t("upload.choose")}
                      </Button>
                      <p className="hidden text-sm text-muted [@media(pointer:fine)]:block">
                        {dragging ? t("upload.dropActive") : t("upload.dropHint")}
                      </p>
                      <p className="text-sm text-muted">{t("upload.limitHint")}</p>
                    </>
                  )}
                  {isContributor ? <p className="text-sm">{t("upload.reviewNote")}</p> : null}
                  {tooMany ? (
                    <Message kind="info">
                      {`Only ${UPLOAD_MAX_FILES_PER_SESSION} photos per upload session; the rest were added as a new batch.`}
                    </Message>
                  ) : null}
                </div>

                {appleSync ? (
                  <Suspense fallback={null}>
                    <SyncCard compact />
                  </Suspense>
                ) : null}

                {googleImport ? (
                  <Suspense fallback={null}>
                    <GoogleCard compact returnTo="/upload" />
                  </Suspense>
                ) : null}

                <div className="flex flex-col gap-3">
                  <Button
                    variant="link"
                    className="self-start !px-0"
                    data-testid="upload-details-toggle"
                    aria-expanded={showDetails}
                    aria-controls="upload-details-panel"
                    onClick={() => setShowDetails((v) => !v)}
                  >
                    {t("upload.detailsToggle")}
                    <IonIcon
                      aria-hidden
                      icon={chevronDown}
                      className={`h-4 w-4 transition-transform duration-200 ${showDetails ? "rotate-180" : ""}`}
                    />
                  </Button>
                  <div id="upload-details-panel" hidden={!showDetails}>
                    <DetailsPanel value={form} onChange={setForm} />
                  </div>
                </div>

                {items.length > 0 ? (
                  <>
                    <div
                      data-testid="upload-summary-bar"
                      className="ll-card sticky top-2 z-10 flex flex-col gap-3 !p-3"
                    >
                      <p data-testid="upload-summary" role="status" className="font-semibold">
                        {summaryText}
                      </p>
                      {summary.active > 0 ? (
                        <>
                          <div
                            role="progressbar"
                            aria-label={t("upload.title")}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-valuenow={Math.round(
                              ((summary.total - summary.active) / Math.max(1, summary.total)) * 100,
                            )}
                            className="ll-progress"
                          >
                            <div
                              style={{
                                width: `${Math.round(((summary.total - summary.active) / Math.max(1, summary.total)) * 100)}%`,
                              }}
                            />
                          </div>
                          <p data-testid="upload-progress" className="text-sm text-muted">
                            {t("upload.progress", {
                              done: summary.total - summary.active,
                              total: summary.total,
                            })}
                          </p>
                        </>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
                        {summary.uploaded > 0 ? (
                          <Button
                            data-testid="upload-view-timeline"
                            onClick={() => navigate("/timeline")}
                          >
                            {t("upload.viewTimeline")}
                          </Button>
                        ) : null}
                        {retryableCount > 0 ? (
                          <Button
                            variant="secondary"
                            data-testid="upload-retry-all"
                            onClick={() => uploadManager.retryFailed(baby.id)}
                          >
                            {t("upload.retryFailed")}
                          </Button>
                        ) : null}
                        {finishedCount > 0 ? (
                          <Button
                            variant="link"
                            data-testid="upload-clear"
                            onClick={() => uploadManager.clearFinished(baby.id)}
                          >
                            {t("upload.clearDone")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <PushPrimer uploaded={summary.uploaded > 0 && summary.active === 0} />
                    <ul className="ll-list" data-testid="upload-list">
                      {items.map((item) => (
                        <UploadRow
                          key={item.clientId}
                          item={item}
                          onRetry={(id) => uploadManager.retry(id)}
                          onCancel={(id) => uploadManager.cancel(id)}
                        />
                      ))}
                    </ul>
                  </>
                ) : null}
              </>
            )}
          </div>
        </section>
      </IonContent>
    </IonPage>
  );
}
