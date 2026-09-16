export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startRingScheduler } = await import("./app/api/room/rings/scheduler");
    startRingScheduler();
    const { startTaskScheduler } = await import('./app/api/room/tasks/scheduler');
    startTaskScheduler();
  }
}
