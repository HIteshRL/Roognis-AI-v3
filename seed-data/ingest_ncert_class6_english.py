#!/usr/bin/env python3
"""Bulk-ingest official NCERT Class 6 English chapter PDFs into Roognis RAG.

Run from the host repo while services are up:

    docker-compose --env-file .env.gemini-template exec -T rag \
      python /app/seed-data/ingest_ncert_class6_english.py

The script downloads PDFs into /tmp inside the RAG container and uploads them
through the normal /api/rag/upload endpoint. PDFs are not stored in Git.

Auth removed: there is no login step and no JWT. The upload endpoint is open,
and schoolId is passed explicitly as a form field (it used to come from the
teacher's token).
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


BASE_PDF_URL = "https://ncert.nic.in/textbook/pdf"

CHAPTERS = [
    {
        "subject": "Science",
        "book": "Curiosity",
        "code": "fecu1",
        "chapters": [
            (1, "The Wonderful World of Science"),
            (2, "Diversity in the Living World"),
            (3, "Mindful Eating: A Path to a Healthy Body"),
            (4, "Exploring Magnets"),
            (5, "Measurement of Length and Motion"),
            (6, "Materials Around Us"),
            (7, "Temperature and its Measurement"),
            (8, "A Journey through States of Water"),
            (9, "Methods of Separation in Everyday Life"),
            (10, "Living Creatures: Exploring their Characteristics"),
            (11, "Nature's Treasures"),
            (12, "Beyond Earth"),
        ],
    },
    {
        "subject": "Mathematics",
        "book": "Ganita Prakash",
        "code": "fegp1",
        "chapters": [
            (1, "Patterns in Mathematics"),
            (2, "Lines and Angles"),
            (3, "Number Play"),
            (4, "Data Handling and Presentation"),
            (5, "Prime Time"),
            (6, "Perimeter and Area"),
            (7, "Fractions"),
            (8, "Playing with Constructions"),
            (9, "Symmetry"),
            (10, "The Other Side of Zero"),
        ],
    },
    {
        "subject": "Social Science",
        "book": "Exploring Society: India and Beyond",
        "code": "fees1",
        "chapters": [
            (1, "Introduction: Why Social Science?"),
            (2, "Oceans and Continents"),
            (3, "Landforms and Life"),
            (4, "Timeline and Sources of History"),
            (5, "India, That is Bharat"),
            (6, "The Beginnings of Indian Civilisation"),
            (7, "India's Cultural Roots"),
            (8, "Unity in Diversity, or Many in the One"),
            (9, "Family and Community"),
            (10, "Grassroots Democracy - Part 1: Governance"),
            (11, "Grassroots Democracy - Part 2: Local Government in Rural Areas"),
            (12, "Grassroots Democracy - Part 3: Local Government in Urban Areas"),
            (13, "The Value of Work"),
            (14, "Economic Activities Around Us"),
        ],
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rag-url", default=os.getenv("RAG_URL", "http://rag:3003"))
    parser.add_argument(
        "--school-id",
        default=os.getenv("DEMO_SCHOOL_ID", "00000000-0000-0000-0000-000000000001"),
        help="Tenant the chapters are ingested under. Must match DEMO_SCHOOL_ID in services/ai.",
    )
    parser.add_argument("--download-dir", default="/tmp/roognis-ncert-class6")
    parser.add_argument("--edition", default="2026-27")
    parser.add_argument("--only-subject", choices=["Science", "Mathematics", "Social Science"])
    parser.add_argument("--force", action="store_true", help="Upload even if a ready document already exists.")
    parser.add_argument("--dry-run", action="store_true", help="Print planned uploads without downloading or uploading.")
    parser.add_argument(
        "--strict-tls",
        action="store_true",
        help="Verify NCERT TLS certificates. Default is off for local networks with TLS interception.",
    )
    return parser.parse_args()


def chapter_url(code: str, chapter_number: int) -> str:
    return f"{BASE_PDF_URL}/{code}{chapter_number:02d}.pdf"


def run(command: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        command_text = " ".join(command[:2] + ["..."])
        sys.stderr.write(result.stderr or result.stdout or f"{command_text} failed\n")
        raise SystemExit(result.returncode)
    return result


def existing_ready_documents(rag_url: str, school_id: str) -> set[tuple[str, int, str]]:
    result = run(["curl", "-sS", f"{rag_url}/api/rag/documents?grade=6&schoolId={school_id}"])
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Could not parse existing document list; continuing without skip cache.")
        return set()
    if "documents" not in payload:
        raise SystemExit(f"Could not list existing RAG documents: {payload}")

    ready = set()
    for document in payload.get("documents", []):
        if document.get("status") != "ready":
            continue
        if int(document.get("chunkCount") or 0) <= 1:
            continue
        metadata = document.get("metadata") or {}
        subject = str(metadata.get("subject") or "").strip()
        chapter_name = str(metadata.get("chapterName") or "").strip()
        chapter = metadata.get("chapterNumber")
        if subject and chapter and chapter_name:
            ready.add((subject.lower(), int(chapter), chapter_name.lower()))
    return ready


def ensure_pdf(url: str, output_path: Path, *, strict_tls: bool) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.exists() and output_path.stat().st_size > 0 and valid_pdf(output_path):
        return
    output_path.unlink(missing_ok=True)
    command = [
        "curl",
        "-sS",
        "-fL",
        "--retry",
        "4",
        "--retry-delay",
        "2",
        "--retry-all-errors",
        "--connect-timeout",
        "20",
        "--max-time",
        "180",
        "-o",
        str(output_path),
    ]
    if not strict_tls:
        command.insert(1, "-k")
    command.append(url)
    run(command)
    if not valid_pdf(output_path):
        output_path.unlink(missing_ok=True)
        raise SystemExit(f"Downloaded file is not a readable PDF: {url}")


def valid_pdf(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            if handle.read(5) != b"%PDF-":
                return False
        import fitz

        with fitz.open(path) as pdf:
            return pdf.page_count > 0
    except Exception:
        return False


def upload_chapter(
    rag_url: str,
    school_id: str,
    pdf_path: Path,
    *,
    subject: str,
    book: str,
    chapter_number: int,
    chapter_name: str,
    edition: str,
) -> dict:
    result = run(
        [
            "curl",
            "-sS",
            "-X",
            "POST",
            f"{rag_url}/api/rag/upload",
            "-F",
            f"file=@{pdf_path};type=application/pdf",
            "-F",
            f"schoolId={school_id}",
            "-F",
            "board=CBSE",
            "-F",
            "curriculum=NCERT",
            "-F",
            "grade=6",
            "-F",
            f"subject={subject}",
            "-F",
            f"book={book}",
            "-F",
            f"chapterNumber={chapter_number}",
            "-F",
            f"chapterName={chapter_name}",
            "-F",
            "language=English",
            "-F",
            f"edition={edition}",
            "-F",
            f"tags=ncert,class-6,{subject.lower().replace(' ', '-')}",
        ]
    )
    try:
        response = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Upload returned non-JSON response: {result.stdout}") from exc
    if not response.get("documentId"):
        raise SystemExit(f"Upload failed for {subject} chapter {chapter_number}: {response}")
    return response


def iter_chapters(only_subject: str | None):
    for group in CHAPTERS:
        if only_subject and group["subject"] != only_subject:
            continue
        for chapter_number, chapter_name in group["chapters"]:
            yield {
                "subject": group["subject"],
                "book": group["book"],
                "code": group["code"],
                "chapter_number": chapter_number,
                "chapter_name": chapter_name,
                "url": chapter_url(group["code"], chapter_number),
            }


def main() -> int:
    args = parse_args()
    download_dir = Path(args.download_dir)
    chapters = list(iter_chapters(args.only_subject))
    print(f"Planned NCERT Class 6 English chapters: {len(chapters)}")

    if args.dry_run:
        for chapter in chapters:
            print(
                f"[DRY] {chapter['subject']} {chapter['chapter_number']:02d}: "
                f"{chapter['chapter_name']} -> {chapter['url']}"
            )
        return 0

    ready = existing_ready_documents(args.rag_url, args.school_id)
    uploaded = 0
    skipped = 0

    for chapter in chapters:
        key = (
            chapter["subject"].lower(),
            int(chapter["chapter_number"]),
            chapter["chapter_name"].lower(),
        )
        label = f"{chapter['subject']} {chapter['chapter_number']:02d}: {chapter['chapter_name']}"
        if key in ready and not args.force:
            print(f"[SKIP] {label} already ready")
            skipped += 1
            continue

        pdf_path = download_dir / chapter["subject"].replace(" ", "-").lower() / f"{chapter['code']}{chapter['chapter_number']:02d}.pdf"
        print(f"[GET ] {label}")
        ensure_pdf(chapter["url"], pdf_path, strict_tls=args.strict_tls)

        print(f"[POST] {label}")
        response = upload_chapter(
            args.rag_url,
            args.school_id,
            pdf_path,
            subject=chapter["subject"],
            book=chapter["book"],
            chapter_number=chapter["chapter_number"],
            chapter_name=chapter["chapter_name"],
            edition=args.edition,
        )
        status = response.get("status", "unknown")
        chunks = response.get("chunksCreated", "-")
        entities = response.get("entitiesCreated", "-")
        print(f"[OK  ] {label} status={status} chunks={chunks} entities={entities}")
        uploaded += 1

    print(f"Done. Uploaded={uploaded}, skipped={skipped}, planned={len(chapters)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
