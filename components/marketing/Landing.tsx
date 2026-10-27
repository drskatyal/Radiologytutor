"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { TeachMotif } from "@/components/brand/TeachMotif";
import { Button } from "@/components/ui";
import { cn } from "@/components/ui/cn";
import { LANDING_FAQ } from "./faq";
import { TEACH_BEATS, TeachStage } from "./TeachStage";

const EASE = "ease-draw";

const MOTIFS = ["stack", "voice", "publish", "compare"] as const;

function Reveal({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setShown(true);
        observer.disconnect();
      },
      { threshold: 0.18 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn(
        "reveal transition-[opacity,transform] duration-700",
        EASE,
        shown ? "translate-y-0 opacity-100" : "translate-y-8 opacity-0 motion-reduce:translate-y-0",
        className
      )}
    >
      {children}
    </div>
  );
}

const TAGLINE = ["Your", "reading,", "replayed", "on", "the", "study."];

function TaglineReveal() {
  const ref = useRef<HTMLHeadingElement>(null);
  const countRef = useRef(0);
  const [count, setCount] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const words = Array.from(el.querySelectorAll<HTMLElement>("[data-word]"));
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let timer = 0;
    let stopped = false;

    const pump = () => {
      frame = 0;
      if (stopped) return;
      const line = window.innerHeight * 0.62;
      let target = 0;
      for (const word of words) {
        if (word.getBoundingClientRect().top < line) target += 1;
      }
      if (reduce && target > 0) {
        countRef.current = words.length;
        setCount(words.length);
        return;
      }
      if (countRef.current < target) {
        countRef.current += 1;
        setCount(countRef.current);
        timer = window.setTimeout(() => {
          timer = 0;
          if (!stopped) frame = window.requestAnimationFrame(pump);
        }, 70);
      }
    };

    const onScroll = () => {
      if (frame || timer) return;
      frame = window.requestAnimationFrame(pump);
    };

    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      stopped = true;
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return (
    <h2
      ref={ref}
      className="max-w-[680px] text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl"
    >
      {TAGLINE.map((word, index) => (
        <span key={`${word}-${index}`}>
          <span
            data-word
            className={cn(
              "transition-colors duration-500",
              EASE,
              index < count ? "text-primary" : "text-primary/30"
            )}
          >
            {word}
          </span>
          {index === 1 ? <br /> : index < TAGLINE.length - 1 ? " " : null}
        </span>
      ))}
    </h2>
  );
}

const BENEFITS = [
  {
    title: "One recording, every registrar",
    body: "Scroll, window, and point once. The tutor repeats that path for the next registrar on the same study.",
  },
  {
    title: "Questions stay on the slice",
    body: "They ask in the middle of a case. The answer comes back on the open finding, and their place in the teach is kept.",
  },
  {
    title: "You publish when the teach is ready",
    body: "A study stays with you until you publish it. Nothing reaches the library before you say so.",
  },
  {
    title: "Priors sit beside the current study",
    body: "A case can hold more than one study, so a follow up is read against the scan that came before it.",
  },
];

function ReplayFrames() {
  return (
    <ol className="mt-8 grid gap-4 sm:grid-cols-3">
      {TEACH_BEATS.map((frame) => (
        <li
          key={frame.id}
          className={cn(
            "rounded-2xl border bg-surface p-2",
            frame.id === "nodule" ? "border-accent" : "border-subtle"
          )}
        >
          <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-imaging">
            <img
              src={frame.src}
              alt=""
              width={1280}
              height={720}
              draggable={false}
              className={cn("absolute inset-0 h-full w-full object-cover", frame.imageClass)}
            />
            <span className="absolute bottom-3 left-3 rounded-md bg-white px-2 py-1 text-xs font-semibold text-primary">
              {frame.label}
            </span>
          </div>
          <p className="px-2 py-2 text-sm font-semibold tabular-nums text-secondary">Slice {frame.slice}</p>
        </li>
      ))}
    </ol>
  );
}

const STEPS = [
  {
    title: "Upload a study",
    body: "Bring in a DICOM study you are allowed to teach from.",
  },
  {
    title: "Record your first teach",
    body: "Scroll the way you read. Set the window. Point at the finding. Speak the teaching point.",
  },
  {
    title: "Hand it to a registrar",
    body: "They replay the path, ask the tutor, and stay on the images you recorded.",
  },
];

export function Landing({ teachHref }: { teachHref: string }) {
  return (
    <div className="relative">
      <section className="relative mx-auto grid max-w-7xl items-center gap-12 px-4 py-16 sm:px-8 md:grid-cols-12 md:py-24">
        <div className="md:col-span-7">
          <p className="text-sm font-semibold text-accent">Radiology teaching, on the study</p>
          <h1 className="hero-text mt-4 max-w-[680px] text-4xl font-semibold tracking-tight text-balance sm:text-5xl md:text-6xl">
            <span className="block">Teach a case once.</span>
            <span className="block">The tutor replays it on the study.</span>
          </h1>
          <p className="mt-6 max-w-[680px] text-lg text-secondary text-pretty">
            RadLearn records your scroll, window, and narration on the DICOM you already read.
            Registrars replay that path with an AI tutor that stays on the finding.
          </p>
          <div className="mt-8">
            <Link href={teachHref}>
              <Button>Start teaching</Button>
            </Link>
          </div>
          <p className="mt-4 max-w-[680px] text-sm text-secondary text-pretty">
            For consultants and registrars who teach at the workstation.
          </p>
        </div>
        <div className="md:col-span-5 md:col-start-8">
          <TeachStage />
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-8 md:py-24">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-12">
            <h2 className="max-w-[680px] text-3xl font-semibold tracking-tight text-balance md:col-span-5">
              The teach ends when the list does.
            </h2>
            <p className="max-w-[65ch] text-base text-secondary text-pretty md:col-span-6 md:col-start-7">
              Sitting beside a registrar works until the next study is waiting. A slide deck keeps
              the words and loses the scroll, the window, and the slice. RadLearn keeps the teach
              on the study.
            </p>
          </div>
        </Reveal>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-8 md:py-20">
        <ol className="flex flex-col gap-16">
          {BENEFITS.map((benefit, index) => (
            <li key={benefit.title}>
              <Reveal>
                <div className="grid items-end gap-6 md:grid-cols-2">
                  <div className={cn("flex items-end gap-4", index % 2 === 1 && "md:order-2 md:justify-end")}>
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
                      <TeachMotif kind={MOTIFS[index] ?? "stack"} />
                    </span>
                    <p className="text-5xl font-semibold tabular-nums text-accent">0{index + 1}</p>
                  </div>
                  <div className={index % 2 === 1 ? "md:order-1" : undefined}>
                    <h3 className="max-w-[680px] text-2xl font-semibold tracking-tight text-balance">
                      {benefit.title}
                    </h3>
                    <p className="mt-4 max-w-[65ch] text-base text-secondary text-pretty">{benefit.body}</p>
                  </div>
                </div>
              </Reveal>
            </li>
          ))}
        </ol>
      </section>

      <section className="relative bg-surface">
        <div className="mx-auto max-w-7xl px-4 py-20 sm:px-8 md:py-24">
          <TaglineReveal />
        </div>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-8 md:py-24">
        <Reveal>
          <h2 className="max-w-[680px] text-3xl font-semibold tracking-tight text-balance">How a teach is made</h2>
          <ol className="mt-12 flex flex-col gap-10">
            {STEPS.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[auto_1fr] gap-6">
                <span className="text-3xl font-semibold tabular-nums text-accent">0{index + 1}</span>
                <div className="max-w-[65ch]">
                  <h3 className="text-xl font-semibold text-balance">{step.title}</h3>
                  <p className="mt-2 text-base text-secondary text-pretty">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </Reveal>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-8 md:py-24">
        <Reveal>
          <div className="grid gap-8 md:grid-cols-12">
            <p className="text-sm font-semibold text-accent md:col-span-4">A chest teach, replayed</p>
            <div className="md:col-span-8">
              <h2 className="max-w-[680px] text-3xl font-semibold tracking-tight text-balance">
                Lung windows from the carina, then the nodule, then the mediastinum.
              </h2>
              <p className="mt-4 max-w-[65ch] text-base text-secondary text-pretty">
                You record that sequence once. The tutor drives the same slices, sets the same
                window, and answers from the case you authored.
              </p>
              <ReplayFrames />
            </div>
          </div>
        </Reveal>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-8 md:py-24" aria-labelledby="faq-heading">
        <Reveal>
          <h2 id="faq-heading" className="max-w-[680px] text-3xl font-semibold tracking-tight text-balance">
            Questions before you record
          </h2>
          <ul className="mt-12 flex flex-col gap-10">
            {LANDING_FAQ.map((item) => (
              <li key={item.q} className="grid gap-3 md:grid-cols-2 md:gap-12">
                <h3 className="text-lg font-semibold text-balance">{item.q}</h3>
                <p className="max-w-[65ch] text-base text-secondary text-pretty">{item.a}</p>
              </li>
            ))}
          </ul>
        </Reveal>
      </section>

      <section className="relative mx-auto max-w-7xl px-4 py-16 sm:px-8 md:py-24">
        <Reveal>
          <h2 className="max-w-[680px] text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            <span className="block">Record the read once.</span>
            <span className="block">Registrars replay it on the study.</span>
          </h2>
          <p className="mt-6 max-w-[65ch] text-base text-secondary text-pretty">
            Create a teacher account. No card is required. You can stop using RadLearn whenever you choose.
          </p>
          <div className="mt-8">
            <Link href={teachHref}>
              <Button>Start teaching</Button>
            </Link>
          </div>
        </Reveal>
      </section>
    </div>
  );
}
