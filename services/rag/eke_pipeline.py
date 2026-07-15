from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import fitz
from sqlalchemy import delete
from sqlalchemy.orm import Session

from models import (
    Document,
    DocumentIngestionJob,
    DocumentStatus,
    EducationalEntity,
    EntityRelationship,
    EntityType,
    IngestionJobStatus,
    RelationshipType,
    RetrievalChunk,
)


@dataclass(frozen=True)
class ParsedBlock:
    text: str
    page: int
    order: int
    is_heading: bool
    heading_level: int | None = None


@dataclass(frozen=True)
class ExtractionResult:
    pages_parsed: int
    entities_created: int
    relationships_created: int
    canonical_concepts_created: int


SECTION_RE = re.compile(r"^(?P<number>\d+(?:\.\d+)*)(?:\s+|[.)-]+)(?P<title>[A-Za-z].+)$")
ACTIVITY_RE = re.compile(r"\b(activity|try this|do this|materials|procedure)\b", re.IGNORECASE)
EXPERIMENT_RE = re.compile(r"\b(experiment|apparatus)\b", re.IGNORECASE)
OBSERVATION_RE = re.compile(r"\b(observation|observe|you will notice)\b", re.IGNORECASE)
CONCLUSION_RE = re.compile(r"\b(conclusion|we conclude|therefore)\b", re.IGNORECASE)
EXAMPLE_RE = re.compile(r"\b(example|for example|e\.g\.)\b", re.IGNORECASE)
APPLICATION_RE = re.compile(r"\b(application|used in|uses of|dentist|daily life)\b", re.IGNORECASE)
FIGURE_RE = re.compile(r"\b(fig\.|figure|diagram|image)\b", re.IGNORECASE)
TABLE_RE = re.compile(r"\b(table)\b", re.IGNORECASE)
SUMMARY_RE = re.compile(r"\b(summary|recap|what we have learnt|key points)\b", re.IGNORECASE)
LAW_RE = re.compile(r"\b(law|principle)\b", re.IGNORECASE)
FORMULA_RE = re.compile(r"\b(formula|equation)\b|[A-Za-z]\s*=\s*[^=]", re.IGNORECASE)
EXERCISE_RE = re.compile(r"\b(exercise|questions?|answer the following)\b|\?$", re.IGNORECASE)
SAFETY_RE = re.compile(r"\b(safety|caution|warning)\b", re.IGNORECASE)
EXTENSION_RE = re.compile(r"\b(extension|learn more|beyond)\b", re.IGNORECASE)
DEFINITION_RE = re.compile(r"\b(definition|is defined as|are defined as)\b", re.IGNORECASE)


def run_entity_extraction(db: Session, document: Document, job: DocumentIngestionJob) -> ExtractionResult:
    transition_job(db, document, job, DocumentStatus.PARSING, 10)
    parsed_blocks, pages_parsed = parse_pdf_blocks(Path(document.file_path or ""))

    transition_job(
        db,
        document,
        job,
        DocumentStatus.STRUCTURING,
        25,
        pages_parsed=pages_parsed,
    )
    structured_blocks = [block for block in parsed_blocks if block.text]

    transition_job(db, document, job, DocumentStatus.CLASSIFYING, 35)
    purge_existing_extraction(db, document.id)
    result = persist_entities(db, document, structured_blocks, pages_parsed)

    transition_job(
        db,
        document,
        job,
        DocumentStatus.CHUNKING,
        55,
        pages_parsed=pages_parsed,
        entities_created=result.entities_created,
    )
    job.metadata_json = {
        **(job.metadata_json or {}),
        "canonicalConceptsCreated": result.canonical_concepts_created,
        "relationshipsCreated": result.relationships_created,
    }
    db.flush()
    return result


def parse_pdf_blocks(path: Path) -> tuple[list[ParsedBlock], int]:
    if not path.exists():
        raise ValueError(f"PDF file does not exist: {path}")

    parsed: list[ParsedBlock] = []
    with fitz.open(path) as pdf:
        order = 0
        for page_index, page in enumerate(pdf, start=1):
            blocks = sorted(
                page.get_text("blocks"),
                key=lambda block: (round(block[1], 1), round(block[0], 1)),
            )
            for block in blocks:
                if len(block) < 5:
                    continue
                text = normalize_block_text(str(block[4]))
                if not text:
                    continue
                for segment in split_block_segments(text):
                    order += 1
                    is_heading, heading_level = detect_heading(segment)
                    parsed.append(
                        ParsedBlock(
                            text=segment,
                            page=page_index,
                            order=order,
                            is_heading=is_heading,
                            heading_level=heading_level,
                        )
                    )
        return parsed, pdf.page_count


def normalize_block_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("\x00", " ").splitlines()]
    return "\n".join(line for line in lines if line)


def split_block_segments(text: str) -> list[str]:
    segments = [segment.strip() for segment in re.split(r"\n{2,}", text) if segment.strip()]
    if len(segments) > 1:
        return segments
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if len(lines) > 1:
        return lines
    return [text.strip()] if text.strip() else []


def detect_heading(text: str) -> tuple[bool, int | None]:
    if len(text) > 140 or text.endswith((".", "?", "!")):
        return False, None
    section_match = SECTION_RE.match(text)
    if section_match:
        level = section_match.group("number").count(".") + 1
        return True, level
    if text.isupper() and len(text.split()) <= 8:
        return True, 1
    if len(text.split()) <= 7 and ":" not in text and not re.search(r"\b(is|are|was|were)\b", text, re.I):
        return True, 2
    return False, None


def purge_existing_extraction(db: Session, document_id: str) -> None:
    db.execute(delete(EntityRelationship).where(EntityRelationship.document_id == document_id))
    db.execute(delete(RetrievalChunk).where(RetrievalChunk.document_id == document_id))
    db.execute(delete(EducationalEntity).where(EducationalEntity.document_id == document_id))
    db.flush()


def persist_entities(
    db: Session,
    document: Document,
    blocks: list[ParsedBlock],
    pages_parsed: int,
) -> ExtractionResult:
    canonical_by_key: dict[str, EducationalEntity] = {}
    relationships_created = 0
    entities_created = 0

    chapter_canonical, created = get_or_create_canonical(
        db,
        document,
        document.chapter_name,
        canonical_by_key,
        page=1,
        section="chapter",
    )
    entities_created += int(created)

    chapter_entity = create_entity(
        db,
        document,
        entity_type=EntityType.CONCEPT,
        title=document.chapter_name,
        content=document.chapter_name,
        summary=document.chapter_name,
        page=1,
        section="chapter",
        canonical_concept_id=chapter_canonical.id,
        parent_id=None,
        extra_metadata={"objectKind": "chapter", "pagesParsed": pages_parsed},
    )
    entities_created += 1
    relationships_created += link_canonical_to_artifact(db, document, chapter_canonical, chapter_entity)

    current_section = chapter_entity
    current_section_title = document.chapter_name

    for block in blocks:
        if block.is_heading:
            title = clean_heading_title(block.text)
            canonical, created = get_or_create_canonical(
                db,
                document,
                title,
                canonical_by_key,
                page=block.page,
                section=title,
            )
            entities_created += int(created)
            section_entity = create_entity(
                db,
                document,
                entity_type=EntityType.CONCEPT,
                title=title,
                content=block.text,
                summary=title,
                page=block.page,
                section=title,
                canonical_concept_id=canonical.id,
                parent_id=chapter_entity.id,
                extra_metadata={
                    "objectKind": "section",
                    "headingLevel": block.heading_level,
                    "readingOrder": block.order,
                },
            )
            entities_created += 1
            relationships_created += create_parent_relationships(db, document, chapter_entity, section_entity)
            relationships_created += link_canonical_to_artifact(db, document, canonical, section_entity)
            current_section = section_entity
            current_section_title = title
            continue

        entity_type = classify_educational_object(block.text)
        concept_title = extract_concept_title(block.text, current_section_title)
        canonical, created = get_or_create_canonical(
            db,
            document,
            concept_title,
            canonical_by_key,
            page=block.page,
            section=current_section_title,
        )
        entities_created += int(created)
        entity = create_entity(
            db,
            document,
            entity_type=entity_type,
            title=title_for_entity(entity_type, concept_title, block.text),
            content=block.text,
            summary=summarize_text(block.text),
            page=block.page,
            section=current_section_title,
            canonical_concept_id=canonical.id,
            parent_id=current_section.id,
            extra_metadata={"readingOrder": block.order},
        )
        entities_created += 1
        relationships_created += create_parent_relationships(db, document, current_section, entity)
        relationships_created += link_canonical_to_artifact(db, document, canonical, entity)

    return ExtractionResult(
        pages_parsed=pages_parsed,
        entities_created=entities_created,
        relationships_created=relationships_created,
        canonical_concepts_created=len(canonical_by_key),
    )


def get_or_create_canonical(
    db: Session,
    document: Document,
    title: str,
    canonical_by_key: dict[str, EducationalEntity],
    *,
    page: int,
    section: str,
) -> tuple[EducationalEntity, bool]:
    normalized_title = normalize_concept_title(title) or document.chapter_name
    key = normalized_title.casefold()
    if key in canonical_by_key:
        return canonical_by_key[key], False

    entity = create_entity(
        db,
        document,
        entity_type=EntityType.CANONICAL_CONCEPT,
        title=normalized_title,
        content=normalized_title,
        summary=normalized_title,
        page=page,
        section=section,
        canonical_concept_id=None,
        parent_id=None,
        extra_metadata={"objectKind": "canonical_concept"},
    )
    canonical_by_key[key] = entity
    return entity, True


def create_entity(
    db: Session,
    document: Document,
    *,
    entity_type: EntityType,
    title: str,
    content: str,
    summary: str,
    page: int,
    section: str,
    canonical_concept_id: str | None,
    parent_id: str | None,
    extra_metadata: dict | None = None,
) -> EducationalEntity:
    metadata = entity_metadata(document, page=page, section=section, extra=extra_metadata)
    entity = EducationalEntity(
        document_id=document.id,
        school_id=document.school_id,
        entity_type=entity_type.value,
        canonical_concept_id=canonical_concept_id,
        title=title[:240] if title else None,
        content=content,
        summary=summary,
        parent_id=parent_id,
        metadata_json=metadata,
    )
    db.add(entity)
    db.flush()
    return entity


def entity_metadata(document: Document, *, page: int, section: str, extra: dict | None = None) -> dict:
    metadata = dict(document.metadata_json or {})
    metadata.update(
        {
            "schoolId": document.school_id,
            "board": document.board,
            "curriculum": document.curriculum,
            "grade": document.grade,
            "subject": document.subject,
            "book": document.book,
            "chapterNumber": document.chapter_number,
            "chapterName": document.chapter_name,
            "language": document.language,
            "edition": document.edition,
            "section": section,
            "pageStart": page,
            "pageEnd": page,
        }
    )
    if document.curriculum.upper() == "NCERT":
        metadata["sourceType"] = "ncert_textbook"
    if extra:
        metadata.update(extra)
    return metadata


def create_parent_relationships(
    db: Session,
    document: Document,
    parent: EducationalEntity,
    child: EducationalEntity,
) -> int:
    create_relationship(db, document, parent.id, child.id, RelationshipType.HAS_CHILD)
    create_relationship(db, document, child.id, parent.id, RelationshipType.BELONGS_TO)
    create_relationship(db, document, child.id, parent.id, RelationshipType.HAS_PARENT)
    return 3


def link_canonical_to_artifact(
    db: Session,
    document: Document,
    canonical: EducationalEntity,
    entity: EducationalEntity,
) -> int:
    if canonical.id == entity.id:
        return 0
    relationship_type = relationship_for_entity_type(entity.entity_type)
    create_relationship(db, document, canonical.id, entity.id, relationship_type)
    return 1


def create_relationship(
    db: Session,
    document: Document,
    source_id: str,
    target_id: str,
    relationship_type: RelationshipType,
    confidence: float = 1.0,
) -> EntityRelationship:
    relationship = EntityRelationship(
        document_id=document.id,
        school_id=document.school_id,
        source_entity_id=source_id,
        target_entity_id=target_id,
        relationship_type=relationship_type.value,
        confidence=confidence,
        metadata_json={"source": "eke_extraction_pipeline"},
    )
    db.add(relationship)
    db.flush()
    return relationship


def classify_educational_object(text: str) -> EntityType:
    stripped = text.strip()
    if SAFETY_RE.search(stripped):
        return EntityType.SAFETY
    if ACTIVITY_RE.search(stripped):
        return EntityType.ACTIVITY
    if EXPERIMENT_RE.search(stripped):
        return EntityType.EXPERIMENT
    if OBSERVATION_RE.search(stripped):
        return EntityType.OBSERVATION
    if CONCLUSION_RE.search(stripped):
        return EntityType.CONCLUSION
    if SUMMARY_RE.search(stripped):
        return EntityType.SUMMARY
    if LAW_RE.search(stripped):
        return EntityType.LAW
    if FORMULA_RE.search(stripped):
        return EntityType.FORMULA
    if FIGURE_RE.search(stripped):
        return EntityType.DIAGRAM if re.search(r"\bdiagram\b", stripped, re.I) else EntityType.FIGURE
    if TABLE_RE.search(stripped):
        return EntityType.TABLE
    if APPLICATION_RE.search(stripped):
        return EntityType.APPLICATION
    if EXAMPLE_RE.search(stripped):
        return EntityType.EXAMPLE
    if EXERCISE_RE.search(stripped):
        return EntityType.QUESTION if stripped.endswith("?") else EntityType.EXERCISE
    if EXTENSION_RE.search(stripped):
        return EntityType.EXTENSION
    if DEFINITION_RE.search(stripped) or looks_like_definition(stripped):
        return EntityType.DEFINITION
    return EntityType.CONCEPT


def looks_like_definition(text: str) -> bool:
    return bool(re.match(r"^[A-Z][A-Za-z ]{2,80}\s+(is|are)\s+", text))


def clean_heading_title(text: str) -> str:
    section_match = SECTION_RE.match(text.strip())
    if section_match:
        return section_match.group("title").strip(" :-")
    return text.strip(" :-")


def extract_concept_title(text: str, fallback: str) -> str:
    heading_title = clean_heading_title(text)
    definition_match = re.match(
        r"^(?:Definition\s*[:.-]\s*)?(?P<title>[A-Z][A-Za-z][A-Za-z \-]{1,80})\s+(?:is|are|means|refers to)\b",
        heading_title,
    )
    if definition_match:
        return definition_match.group("title").strip(" :-")

    uses_match = re.match(r"^(?:Uses|Applications?)\s+of\s+(?P<title>[^:.-]+)", text, re.I)
    if uses_match:
        return uses_match.group("title").strip(" :-")

    colon_match = re.match(r"^(?:Activity|Experiment|Example|Application|Uses of)\s*\d*(?:\.\d+)?\s*[:.-]\s*(.+)$", text, re.I)
    if colon_match:
        return first_phrase(colon_match.group(1), fallback)

    if len(text.split()) <= 8 and not text.endswith((".", "?", "!")):
        return clean_heading_title(text)
    return fallback


def first_phrase(text: str, fallback: str) -> str:
    cleaned = re.split(r"[.;]", text.strip(), maxsplit=1)[0].strip(" :-")
    if not cleaned:
        return fallback
    words = cleaned.split()
    return " ".join(words[:8])


def title_for_entity(entity_type: EntityType, concept_title: str, text: str) -> str:
    if entity_type == EntityType.QUESTION:
        return first_phrase(text.rstrip("?"), concept_title)
    if entity_type in {EntityType.ACTIVITY, EntityType.EXPERIMENT, EntityType.EXERCISE}:
        return first_phrase(text, concept_title)
    return concept_title


def summarize_text(text: str, limit: int = 220) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "..."


def normalize_concept_title(title: str) -> str:
    title = re.sub(r"\s+", " ", title or "").strip(" :-")
    title = re.sub(r"^(chapter|section)\s+\d+(?:\.\d+)*\s*", "", title, flags=re.I)
    return title[:180]


def relationship_for_entity_type(entity_type: str) -> RelationshipType:
    if entity_type in {EntityType.FIGURE.value, EntityType.DIAGRAM.value, EntityType.TABLE.value}:
        return RelationshipType.ILLUSTRATED_BY
    if entity_type in {EntityType.APPLICATION.value, EntityType.ACTIVITY.value, EntityType.EXPERIMENT.value}:
        return RelationshipType.USED_IN
    if entity_type in {EntityType.EXAMPLE.value, EntityType.QUESTION.value, EntityType.EXERCISE.value}:
        return RelationshipType.EXAMPLE_OF
    if entity_type == EntityType.SUMMARY.value:
        return RelationshipType.SUMMARIZED_BY
    return RelationshipType.EXPLAINED_BY


def transition_job(
    db: Session,
    document: Document,
    job: DocumentIngestionJob,
    stage: DocumentStatus,
    progress_percent: int,
    *,
    pages_parsed: int | None = None,
    entities_created: int | None = None,
) -> None:
    document.status = stage.value
    job.status = IngestionJobStatus.RUNNING.value
    job.stage = stage.value
    job.progress_percent = progress_percent
    if pages_parsed is not None:
        job.pages_parsed = pages_parsed
    if entities_created is not None:
        job.entities_created = entities_created
    db.flush()
