interface Observation {
  state: string;
  observedAt: number;
}

export function observationFresh(observation?: Observation): boolean {
  const age = observation && Date.now() - observation.observedAt;
  return typeof age === "number" && age >= 0 && age < 60_000;
}

export function containerStateLabel(observation?: Observation): string {
  if (!observationFresh(observation)) {
    return "확인 중 · 상태 정보 없음";
  }
  return (
    (
      {
        running: "실행 중",
        exited: "중지됨",
        dead: "중지됨 · 오류",
        created: "생성됨 · 시작 전",
        restarting: "재시작 중",
        paused: "일시 정지",
        missing: "미생성",
        unknown: "확인 실패",
      } as Record<string, string>
    )[observation!.state] ?? observation!.state
  );
}

export function runnerConnection(ready: boolean, observation?: Observation) {
  if (ready) {
    return { connectionLabel: "연결됨", connectionStatus: "active" };
  }
  if (observationFresh(observation)) {
    const label = containerStateLabel(observation);
    return {
      connectionLabel:
        observation!.state === "running" ? "실행 중 · 연결 확인 실패" : label,
      connectionStatus: "pending",
    };
  }
  return {
    connectionLabel: "연결 확인 실패 · 상태 확인 중",
    connectionStatus: "pending",
  };
}
