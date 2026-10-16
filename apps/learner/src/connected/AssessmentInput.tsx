import React from "react";
import { Platform, Text, View } from "react-native";
import type { Question } from "../client/apiClient";
import { ChoiceList, colors, Field, styles } from "../components/ui";
import { CodeEditor } from "../components/CodeEditor";
import { numericPayload, traceAnswers, writtenLabel } from "./answers";

export { answerPayload, isCode, isWritten, numericPayload, traceAnswers } from "./answers";

/** Native learner input for each item type, built from the native controls: the same labels,
 * hints, unit handling and drafts as the web input, so an answer means the same on both. */
export function AssessmentInput({ question, answer, pending, onChange }: { question: Question; answer: string; pending: boolean; onChange: (answer: string) => void }) {
  if (question.type === "choice")
    return <ChoiceList label="Your answer" options={question.options.map((o) => ({ id: o.id, label: o.text }))} value={answer} onChange={onChange} disabled={pending} />;
  if (question.type === "numeric" || question.type === "prediction") {
    // A stated unit that differs from the item's is pointed out before sending; it is never graded wrong.
    const parsed = numericPayload(answer, question.unit);
    const unitProblem = "wrongUnit" in parsed ? parsed.error : "";
    return (
      <View style={{ gap: 8 }}>
        {question.type === "prediction" && <Text style={styles.small}>Commit to a number before you see the result. A wrong prediction is useful too.</Text>}
        <Field
          label={`${question.type === "prediction" ? "Your prediction" : "Your numeric answer"}${question.unit ? ` (${question.unit})` : ""}`}
          value={answer}
          onChangeText={onChange}
          editable={!pending}
          autoCapitalize="none"
          autoCorrect={false}
          // iOS's decimal pad has no minus sign; this keyboard has digits, signs and letters for a unit.
          keyboardType={Platform.OS === "ios" ? "numbers-and-punctuation" : "default"}
          inputMode={Platform.OS === "web" ? "decimal" : undefined}
        />
        {question.unit && <Text style={styles.small}>Type the number; adding “{question.unit}” after it is fine.</Text>}
        <Text role="status" accessibilityLiveRegion="polite" style={[styles.small, { color: colors.gold }]}>
          {unitProblem}
        </Text>
      </View>
    );
  }
  if (question.type === "trace") {
    const values = traceAnswers(answer);
    return (
      <View role="list" aria-label="Trace steps" style={{ gap: 12 }}>
        {question.steps.map((step) => (
          <View key={step.id} role="listitem">
            <Field
              label={step.prompt}
              value={values[step.id] ?? ""}
              onChangeText={(text) => onChange(JSON.stringify({ ...values, [step.id]: text }))}
              editable={!pending}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={2000}
            />
          </View>
        ))}
      </View>
    );
  }
  if (question.type === "code" || question.type === "code_repair")
    return <CodeEditor language={question.language} value={answer} onChange={onChange} disabled={pending} />;
  if (!("criteria" in question)) return null;
  return (
    <View style={{ gap: 12 }}>
      <View style={{ gap: 6 }}>
        <Text style={styles.eyebrow}>A reviewer will look for</Text>
        <View role="list" style={{ gap: 4 }}>
          {question.criteria.map((c) => (
            <Text key={c.id} role="listitem" style={styles.body}>
              • {c.description}
              {!c.required && <Text style={styles.small}> (optional)</Text>}
            </Text>
          ))}
        </View>
        <Text style={styles.small}>Use your own words. A reviewer quotes what you wrote; a pasted reply from the companion is not accepted.</Text>
      </View>
      <Field label={writtenLabel[question.type] ?? "Your answer"} value={answer} onChangeText={onChange} multiline numberOfLines={6} maxLength={8000} editable={!pending} />
    </View>
  );
}
