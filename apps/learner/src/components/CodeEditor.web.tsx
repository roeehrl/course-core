import React, { useEffect, useId, useRef, useState } from "react";
import type { CodeEditorProps } from "./CodeEditor";
import {
  codeProtocol,
  MAX_CODE_BYTES,
  codeSubmissionError,
  utf8Bytes,
} from "../connected/code";
import { useCompanionAvailable } from "../connected/companion/bridge";
import { codeCandidate, codeSelection, isAskButton } from "../connected/companion/selectionAttach";
import { useT } from "../i18n";
import { PracticeRunner } from "./PracticeRunner.web";
export function CodeEditor({
  language,
  value,
  onChange,
  disabled,
  practice,
}: CodeEditorProps) {
  const t = useT();
  const id = useId(),
    editor = useRef<HTMLTextAreaElement>(null),
    fileInput = useRef<HTMLInputElement>(null),
    generation = useRef(0);
  const [importing, setImporting] = useState(false),
    [fileError, setFileError] = useState(""),
    [fileNotice, setFileNotice] = useState("");
  const error = codeSubmissionError(language, value, t);
  const companion = useCompanionAvailable();
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  // Selected lines of the learner's own code are offered to the floating "Ask companion" button
  // (AskFromLesson); nothing goes with a message until the learner presses it.
  function offerSelection() {
    const field = editor.current;
    if (!field) return;
    const candidate = companion ? codeCandidate(field) : null;
    if (candidate) codeSelection.offer(candidate);
    else codeSelection.withdraw(field);
  }
  const offerRef = useRef(offerSelection);
  offerRef.current = offerSelection;
  useEffect(() => {
    const field = editor.current;
    if (!companion) codeSelection.withdraw(field);
    // Browsers also tell the field itself when its selection changes (a script or an assistive
    // technology selecting lines fires no pointer or key event).
    const changed = () => offerRef.current();
    field?.addEventListener("select", changed);
    field?.addEventListener("selectionchange", changed);
    return () => {
      field?.removeEventListener("select", changed);
      field?.removeEventListener("selectionchange", changed);
      codeSelection.withdraw(field);
    };
  }, [companion]);
  useEffect(() => {
    if (disabled) {
      generation.current++;
      setImporting(false);
    }
  }, [disabled]);
  function update(next: string) {
    generation.current++;
    setImporting(false);
    setFileError("");
    setFileNotice("");
    onChange(next);
  }
  async function importFile(file: File) {
    const ticket = ++generation.current;
    setImporting(true);
    setFileError("");
    setFileNotice("");
    try {
      if (file.size > MAX_CODE_BYTES)
        throw Error(t("codeEditor.error.tooLarge", { max: MAX_CODE_BYTES }));
      if (!/\.(py|txt)$/i.test(file.name))
        throw Error(t("codeEditor.error.type"));
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw Error(t("codeEditor.error.encoding"));
      }
      if (source.includes("\0"))
        throw Error(t("codeEditor.error.nul"));
      if (ticket !== generation.current) return;
      onChange(source);
      setFileNotice(t("codeEditor.imported", { file: file.name }));
    } catch (cause) {
      if (ticket === generation.current)
        setFileError(
          cause instanceof Error
            ? cause.message
            : t("codeEditor.error.failed"),
        );
    } finally {
      if (ticket === generation.current) setImporting(false);
    }
  }
  function insertSpaces() {
    const field = editor.current;
    if (!field) return;
    const start = field.selectionStart,
      end = field.selectionEnd,
      next = value.slice(0, start) + "    " + value.slice(end);
    if (next.length > MAX_CODE_BYTES) {
      setFileError(t("codeEditor.error.noRoom"));
      return;
    }
    update(next);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(start + 4, start + 4);
    });
  }
  return (
    <div className="connected-code-editor">
      <div className="connected-code-top">
        <label htmlFor={`${id}-source`}>{t("codeEditor.yourCode")}</label>
        <span>
          {language === "python"
            ? t("codeEditor.language.python")
            : t("codeEditor.language.unsupported")}
        </span>
      </div>
      <p id={`${id}-protocol`} className="connected-code-protocol">
        {codeProtocol(t)}
      </p>
      <div className="connected-code-tools">
        <button type="button" disabled={disabled} onClick={insertSpaces}>
          {t("codeEditor.insertSpaces")}
        </button>
        <button
          type="button"
          disabled={disabled || importing}
          onClick={() => fileInput.current?.click()}
        >
          {importing ? t("codeEditor.reading") : t("codeEditor.import")}
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept=".py,.txt,text/x-python,text/plain"
          aria-label={t("codeEditor.chooseFile")}
          disabled={disabled || importing}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
      <textarea
        ref={editor}
        id={`${id}-source`}
        aria-label={t("codeEditor.yourCode")}
        dir="ltr"
        aria-describedby={`${id}-protocol ${id}-help${error ? ` ${id}-error` : ""}`}
        aria-invalid={error && value.trim() ? true : undefined}
        value={value}
        onChange={(event) => update(event.target.value)}
        onSelect={offerSelection}
        onBlur={(event) => {
          // Focus moving to the floating button keeps the offer; anywhere else withdraws it.
          if (!isAskButton(event.relatedTarget)) codeSelection.withdraw(event.currentTarget);
        }}
        readOnly={disabled}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        inputMode="text"
        wrap="off"
        rows={14}
        maxLength={MAX_CODE_BYTES}
      />
      <div id={`${id}-help`} className="connected-code-help">
        <span>{t("codeEditor.tabHint")}</span>
        <span>
          {t("codeEditor.bytes", { bytes: utf8Bytes(value), max: MAX_CODE_BYTES })}
        </span>
      </div>
      {error && (
        <p id={`${id}-error`} className="connected-code-error">
          {error}
        </p>
      )}
      {fileError && (
        <p role="alert" className="connected-code-error">
          {fileError}
        </p>
      )}
      {fileNotice && (
        <p role="status" className="connected-code-help">
          {fileNotice}
        </p>
      )}
      {practice && (
        <PracticeRunner language={language} source={value} disabled={disabled} />
      )}
    </div>
  );
}
