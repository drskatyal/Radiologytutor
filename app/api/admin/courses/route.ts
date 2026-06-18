// Admin courses API (org-scoped). The client never imports lib/cases (§3).
//
//   GET  /api/admin/courses  -> this org's courses (all statuses)
//   POST /api/admin/courses  -> create a course { title, caseIds?, ... }

import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_ORG_ID, listCourses, createCourse } from "@/lib/cases";
import {
  BODY_SYSTEMS,
  DIFFICULTIES,
  type BodySystem,
  type CaseStatus,
  type Difficulty,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ORG = DEFAULT_ORG_ID;

function asSystem(v: unknown): BodySystem | undefined {
  return typeof v === "string" && (BODY_SYSTEMS as string[]).includes(v)
    ? (v as BodySystem)
    : undefined;
}
function asDifficulty(v: unknown): Difficulty | undefined {
  return typeof v === "string" && (DIFFICULTIES as string[]).includes(v)
    ? (v as Difficulty)
    : undefined;
}

export async function GET() {
  const courses = await listCourses(ORG);
  return NextResponse.json({ courses });
}

interface CourseBody {
  title?: string;
  description?: string;
  difficulty?: string;
  system?: string;
  authorId?: string;
  caseIds?: string[];
  status?: CaseStatus;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as CourseBody;
    const title = (body.title ?? "").trim();
    if (!title) {
      return NextResponse.json({ error: "Course title is required." }, { status: 400 });
    }
    const course = await createCourse(ORG, {
      title,
      description: body.description?.trim() || undefined,
      difficulty: asDifficulty(body.difficulty),
      system: asSystem(body.system),
      authorId: body.authorId || undefined,
      caseIds: Array.isArray(body.caseIds) ? body.caseIds : [],
      status: body.status === "published" ? "published" : "draft",
    });
    return NextResponse.json({ course });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
