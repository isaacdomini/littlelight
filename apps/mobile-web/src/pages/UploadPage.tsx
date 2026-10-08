import { IonContent, IonPage } from "@ionic/react";
import {
  MILESTONE_PRESETS,
  UPLOAD_MAX_FILES_PER_SESSION,
  type UploadDetails,
} from "@littlelight/shared";
import { type DragEvent, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useCurrentBaby } from "../auth/AuthProvider";
import { AppHeader } from "../components/AppHeader";
import { UploadRow } from "../components/UploadRow";
import { Button, Card, Message, TextField } from "../components/ui";
import { t } from "../i18n";
import { usePhotosInvalidation } from "../lib/queries";
import { clearResumableUpload, hasResumableUpload, uploadManager } from "../lib/upload/manager";
import { useUploadItems } from "../lib/upload/useUploads";
import { FILE_ACCEPT } from "../lib/upload/validate";

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
    <div className="flex flex-col gap-3" data-testid="upload-details">
      <p className="text-sm opacity-70">{t("upload.detailsHint")}</p>
      <div className="flex flex-col gap-1">
        <label htmlFor="upload-milestone" className="text-sm font-medium">
          {t("upload.milestone")}
        </label>
        <select
          id="upload-milestone"
          data-testid="upload-milestone"
          className="min-h-11 w-full rounded-lg border border-gray-500/50 bg-transparent px-3 py-2 text-base text-[var(--ion-text-color)]"
          value={value.milestoneId}
          onChange={(e) => onChange({ ...value, milestoneId: e.target.value })}
        >
          <option value="">{t("upload.milestoneNone")}</option>
          {MILESTONE_PRESETS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-end gap-2">
          <div className="flex-1">
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
          <ul className="flex flex-wrap gap-2">
            {value.people.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  className="min-h-11 rounded-full border border-gray-500/50 px-3"
                  aria-label={t("upload.peopleRemove", { name })}
                  onClick={() =>
                    onChange({ ...value, people: value.people.filter((p) => p !== name) })
                  }
                >
                  {name} &times;
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="upload-note" className="text-sm font-medium">
          {t("upload.note")}
        </label>
        <textarea
          id="upload-note"
          data-testid="upload-note"
          rows={3}
          maxLength={2000}
          className="w-full rounded-lg border border-gray-500/50 bg-transparent px-3 py-2 text-base text-[var(--ion-text-color)]"
          value={value.note}
          onChange={(e) => onChange({ ...value, note: e.target.value })}
        />
      </div>
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
  const [resumable, setResumable] = useState(() => (babyId ? hasResumableUpload(babyId) : false));
  const [tooMany, setTooMany] = useState(false);

  const isContributor = baby?.role === "contributor";
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
          className={`min-h-full p-4 ${dragging ? "bg-[var(--ion-color-primary)]/10 outline-2 -outline-offset-8 outline-dashed outline-[var(--ion-color-primary)]" : ""}`}
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
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
            {!baby ? (
              <p className="opacity-70">{t("upload.noBaby")}</p>
            ) : (
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

                {resumable ? (
                  <Card className="flex flex-col gap-2" data-testid="upload-resume">
                    <h2 className="font-semibold">{t("upload.resumeTitle")}</h2>
                    <p className="text-sm opacity-80">{t("upload.resumeBody")}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button onClick={() => resumeInputRef.current?.click()}>
                        {t("upload.resumeChoose")}
                      </Button>
                      <Button
                        variant="link"
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

                <div className="flex flex-col items-start gap-2">
                  <Button data-testid="upload-choose" onClick={() => inputRef.current?.click()}>
                    {t("upload.choose")}
                  </Button>
                  <p className="hidden text-sm opacity-70 [@media(pointer:fine)]:block">
                    {dragging ? t("upload.dropActive") : t("upload.dropHint")}
                  </p>
                  <p className="text-sm opacity-70">{t("upload.limitHint")}</p>
                  {isContributor ? <p className="text-sm">{t("upload.reviewNote")}</p> : null}
                  {tooMany ? (
                    <Message kind="info">
                      {`Only ${UPLOAD_MAX_FILES_PER_SESSION} photos per upload session; the rest were added as a new batch.`}
                    </Message>
                  ) : null}
                </div>

                <div className="flex flex-col gap-2">
                  <Button
                    variant="link"
                    className="self-start"
                    data-testid="upload-details-toggle"
                    aria-expanded={showDetails}
                    aria-controls="upload-details-panel"
                    onClick={() => setShowDetails((v) => !v)}
                  >
                    {t("upload.detailsToggle")}
                  </Button>
                  <div id="upload-details-panel" hidden={!showDetails}>
                    <DetailsPanel value={form} onChange={setForm} />
                  </div>
                </div>

                {items.length > 0 ? (
                  <>
                    <div
                      data-testid="upload-summary-bar"
                      className="sticky top-0 z-10 flex flex-col gap-2 rounded-lg border border-gray-500/30 bg-[var(--ion-background-color)] p-3"
                    >
                      <p data-testid="upload-summary" role="status" className="font-semibold">
                        {summaryText}
                      </p>
                      {summary.active > 0 ? (
                        <p data-testid="upload-progress" className="text-sm opacity-70">
                          {t("upload.progress", {
                            done: summary.total - summary.active,
                            total: summary.total,
                          })}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap gap-2">
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
                        {summary.uploaded > 0 ? (
                          <Button
                            data-testid="upload-view-timeline"
                            onClick={() => navigate("/timeline")}
                          >
                            {t("upload.viewTimeline")}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <ul className="flex flex-col gap-2" data-testid="upload-list">
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
