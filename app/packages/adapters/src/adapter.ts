import type { Cli, BuildCommandArgs, BuildCommandResult, DoctorReport, Usage } from "./types.js";
import { buildCommand } from "./build-command.js";
import { parseOutput } from "./parse-output.js";
import { extractUsage } from "./usage.js";
import { resumeCommand } from "./resume.js";
import { doctor } from "./doctor.js";
import { Stream } from "./stream.js";

/** A convenience object per CLI, assembled from the shared functions above
 * (which are all parametrized by `cli` rather than duplicated four times --
 * mirrors crewbench_dispatch.py's own structure, one script branching on
 * `--cli`, rather than four near-identical files). This is the shape
 * docs/app/phase-1-plan.md's target layout calls "CliAdapter"; the
 * runner (a later milestone) consumes one of these per role dispatch. */
export interface CliAdapter {
  readonly cli: Cli;
  buildCommand(args: Omit<BuildCommandArgs, "cli">, prompt: string, promptFile: string, schemaPath: string, tmpDir: string): BuildCommandResult;
  newStream(): Stream;
  parseOutput(stream: Stream, stdout: string, extraOutputFile: string | null): ReturnType<typeof parseOutput>;
  extractUsage(stream: Stream, stdout: string, durationS: number, extraOutputFile?: string | null): Usage;
  resumeCommand(sessionId: string | null): string | null;
  doctor(): Promise<DoctorReport>;
}

export function createAdapter(cli: Cli): CliAdapter {
  return {
    cli,
    buildCommand: (args, prompt, promptFile, schemaPath, tmpDir) =>
      buildCommand({ ...args, cli }, prompt, promptFile, schemaPath, tmpDir),
    newStream: () => new Stream(cli),
    parseOutput: (stream, stdout, extraOutputFile) => parseOutput(cli, stream, stdout, extraOutputFile),
    extractUsage: (stream, stdout, durationS, extraOutputFile) => extractUsage(cli, stream, stdout, durationS, extraOutputFile),
    resumeCommand: (sessionId) => resumeCommand(cli, sessionId),
    doctor: () => doctor(cli),
  };
}
