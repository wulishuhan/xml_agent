export async function runAgent(data) {
  const response = await fetch("/api/run", {
    method: "POST",

    headers: {
      "Content-Type": "application/json",
    },

    body: JSON.stringify(data),
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to start agent");
  }

  return result;
}

export async function getSession(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}`);

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to get session");
  }

  return result;
}

export async function getSessionOutput(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/output`);

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to get session output");
  }

  return result;
}

export async function stopSession(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}/stop`, {
    method: "POST",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to stop session");
  }

  return result;
}

export async function getSessions() {
  const response = await fetch("/api/sessions");

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to get sessions");
  }

  return result;
}

export async function deleteSession(sessionId) {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    method: "DELETE",
  });

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to delete session");
  }

  return result;
}
