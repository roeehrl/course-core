import React, { useState } from "react";
import { Platform } from "react-native";
import { ConnectedHost } from "./src/ConnectedHost";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { LearnerApp } from "./src/LearnerApp";
import { createDemoClient } from "./src/client/demoClient";
import { createResilientStorage, deviceStorage } from "./src/client/storage";
import { demoAnswers, demoCourse } from "./src/data/demoCourse";

export default function App() {
  if (
    Platform.OS === "web" &&
    typeof window !== "undefined" &&
    window.location.pathname !== "/demo"
  )
    return (
      <SafeAreaProvider>
        <ConnectedHost />
      </SafeAreaProvider>
    );
  return <DemoApp />;
}
function DemoApp() {
  const [unavailable, setUnavailable] = useState(false);
  const [storage] = useState(() =>
    createResilientStorage(deviceStorage, () => setUnavailable(true)),
  );
  const [client] = useState(() =>
    createDemoClient(
      demoCourse,
      {
        answers: demoAnswers,
        placement: { answer: "ascending", lessonId: "order" },
      },
      storage,
      `course-core:demo:${demoCourse.id}:${demoCourse.version}`,
    ),
  );
  return (
    <SafeAreaProvider>
      <LearnerApp
        course={demoCourse}
        client={client}
        storage={storage}
        learnerKey="local-demo"
        storageUnavailable={unavailable}
      />
    </SafeAreaProvider>
  );
}
