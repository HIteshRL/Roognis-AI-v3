from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass
from urllib.parse import urlparse

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from config import Settings
from models import (
    Document,
    DocumentIngestionJob,
    DocumentStatus,
    EducationalEntity,
    EntityType,
    IngestionJobStatus,
    RetrievalChunk,
)


@dataclass(frozen=True)
class ChunkingResult:
    chunks_created: int
    chunks_embedded: int
    collection_name: str


class IndexingClient:
    def __init__(self, settings: Settings):
        self.settings = settings
        self._ollama_client = None
        self._chroma_collection = None

    def embed(self, text: str) -> list[float]:
        if self.settings.rag_test_mode:
            return deterministic_embedding(text)
        client = self._get_ollama_client()
        response = client.embeddings(model=self.settings.ollama_embedding_model, prompt=text)
        embedding = getattr(response, "embedding", None)
        if embedding is None and isinstance(response, dict):
            embedding = response.get("embedding")
        if not isinstance(embedding, Sequence) or isinstance(embedding, (str, bytes)) or not embedding:
            raise RuntimeError("Ollama returned an empty embedding.")
        return [float(value) for value in embedding]

    def upsert_chunk(self, chunk: RetrievalChunk, embedding: list[float], collection_name: str) -> None:
        if self.settings.rag_test_mode:
            return
        collection = self._get_chroma_collection(collection_name)
        collection.upsert(
            ids=[chunk.vector_id or chunk.id],
            embeddings=[embedding],
            documents=[chunk.text],
            metadatas=[flatten_metadata(chunk.metadata_json)],
        )

    def _get_ollama_client(self):
        if self._ollama_client is None:
            import ollama

            self._ollama_client = ollama.Client(host=self.settings.ollama_url)
        return self._ollama_client

    def _get_chroma_collection(self, collection_name: str):
        if self._chroma_collection is not None:
            return self._chroma_collection
        import chromadb

        parsed = urlparse(self.settings.chroma_url)
        host = parsed.hostname or self.settings.chroma_url
        port = parsed.port or (443 if parsed.scheme == "https" else 8000)
        self._chroma_collection = chromadb.HttpClient(
            host=host,
            port=port,
            ssl=parsed.scheme == "https",
        ).get_or_create_collection(name=collection_name)
        return self._chroma_collection


def generate_chunks_and_embeddings(
    db: Session,
    document: Document,
    job: DocumentIngestionJob,
    settings: Settings,
) -> ChunkingResult:
    transition_job(db, document, job, DocumentStatus.CHUNKING, 65)
    db.execute(delete(RetrievalChunk).where(RetrievalChunk.document_id == document.id))
    db.flush()

    entities = db.scalars(
        select(EducationalEntity)
        .where(
            EducationalEntity.document_id == document.id,
            EducationalEntity.entity_type != EntityType.CANONICAL_CONCEPT.value,
        )
        .order_by(EducationalEntity.created_at.asc(), EducationalEntity.id.asc())
    ).all()

    chunks = [
        create_chunk(db, document, entity, index)
        for index, entity in enumerate(entities, start=1)
        if chunk_text_for_entity(entity)
    ]
    job.chunks_created = len(chunks)
    db.flush()

    transition_job(
        db,
        document,
        job,
        DocumentStatus.EMBEDDING,
        80,
        chunks_created=len(chunks),
    )
    collection_name = collection_name_for_document(document, settings)
    indexing_client = IndexingClient(settings)
    chunks_embedded = 0

    for chunk in chunks:
        embedding = indexing_client.embed(chunk.text)
        vector_id = vector_id_for_chunk(chunk)
        chunk.vector_id = vector_id
        chunk.metadata_json = {
            **(chunk.metadata_json or {}),
            "embeddingModel": settings.ollama_embedding_model,
            "vectorId": vector_id,
            "collection": collection_name,
        }
        indexing_client.upsert_chunk(chunk, embedding, collection_name)
        chunks_embedded += 1

    job.chunks_embedded = chunks_embedded
    job.metadata_json = {
        **(job.metadata_json or {}),
        "collection": collection_name,
        "embeddingModel": settings.ollama_embedding_model,
        "chunksCreated": len(chunks),
        "chunksEmbedded": chunks_embedded,
    }
    transition_job(
        db,
        document,
        job,
        DocumentStatus.INDEXED,
        95,
        chunks_created=len(chunks),
        chunks_embedded=chunks_embedded,
    )
    document.status = DocumentStatus.READY.value
    job.status = IngestionJobStatus.SUCCEEDED.value
    job.stage = DocumentStatus.READY.value
    job.progress_percent = 100
    db.flush()

    return ChunkingResult(
        chunks_created=len(chunks),
        chunks_embedded=chunks_embedded,
        collection_name=collection_name,
    )


def create_chunk(
    db: Session,
    document: Document,
    entity: EducationalEntity,
    chunk_index: int,
) -> RetrievalChunk:
    metadata = chunk_metadata(document, entity)
    text = chunk_text_for_entity(entity)
    chunk = RetrievalChunk(
        document_id=document.id,
        entity_id=entity.id,
        canonical_concept_id=entity.canonical_concept_id,
        school_id=document.school_id,
        board=document.board,
        curriculum=document.curriculum,
        subject=document.subject,
        grade=document.grade,
        chapter_number=document.chapter_number,
        chapter_name=document.chapter_name,
        chunk_index=chunk_index,
        chunk_type=chunk_type_for_entity(entity.entity_type),
        text=text,
        source=source_for_chunk(document, metadata),
        source_page=metadata.get("pageStart"),
        page_start=metadata.get("pageStart"),
        page_end=metadata.get("pageEnd"),
        pedagogical_order=pedagogical_order_for_entity(entity),
        token_count=estimate_token_count(text),
        metadata_json=metadata,
    )
    db.add(chunk)
    db.flush()
    return chunk


def chunk_text_for_entity(entity: EducationalEntity) -> str:
    parts = [
        entity.title or "",
        entity.summary or "",
        entity.content or "",
    ]
    compact_parts = []
    seen = set()
    for part in parts:
        compact = normalize_text(part)
        if compact and compact not in seen:
            compact_parts.append(compact)
            seen.add(compact)
    return "\n".join(compact_parts)


def chunk_metadata(document: Document, entity: EducationalEntity) -> dict:
    entity_metadata = dict(entity.metadata_json or {})
    return {
        **entity_metadata,
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
        "documentId": document.id,
        "entityId": entity.id,
        "canonicalConceptId": entity.canonical_concept_id,
        "entityType": entity.entity_type,
        "chunkType": chunk_type_for_entity(entity.entity_type),
    }


def chunk_type_for_entity(entity_type: str) -> str:
    if entity_type == EntityType.QUESTION.value:
        return "question"
    if entity_type in {EntityType.ACTIVITY.value, EntityType.EXPERIMENT.value}:
        return "activity"
    if entity_type in {EntityType.FIGURE.value, EntityType.DIAGRAM.value, EntityType.TABLE.value}:
        return "visual"
    return "semantic"


def source_for_chunk(document: Document, metadata: dict) -> str:
    page = metadata.get("pageStart")
    page_copy = f", p.{page}" if page else ""
    return (
        f"{document.curriculum} {document.subject} Grade {document.grade}, "
        f"{document.book}, Chapter {document.chapter_number}{page_copy}"
    )


def pedagogical_order_for_entity(entity: EducationalEntity) -> int:
    base_order = {
        EntityType.CONCEPT.value: 10,
        EntityType.DEFINITION.value: 20,
        EntityType.FIGURE.value: 30,
        EntityType.DIAGRAM.value: 30,
        EntityType.ACTIVITY.value: 40,
        EntityType.EXPERIMENT.value: 40,
        EntityType.OBSERVATION.value: 50,
        EntityType.CONCLUSION.value: 60,
        EntityType.APPLICATION.value: 70,
        EntityType.SUMMARY.value: 80,
        EntityType.EXERCISE.value: 90,
        EntityType.QUESTION.value: 95,
    }.get(entity.entity_type, 50)
    reading_order = int((entity.metadata_json or {}).get("readingOrder") or 0)
    return base_order * 1000 + reading_order


def estimate_token_count(text: str) -> int:
    return max(1, int(len(re.findall(r"\S+", text)) * 1.3))


def collection_name_for_document(document: Document, settings: Settings) -> str:
    school = normalize_collection_part(document.school_id)
    subject = normalize_collection_part(document.subject)
    return f"{settings.rag_collection_prefix}_{school}_{subject}"


def normalize_collection_part(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.lower()).strip("_") or "default"


def vector_id_for_chunk(chunk: RetrievalChunk) -> str:
    digest = hashlib.sha256(f"{chunk.document_id}:{chunk.id}:{chunk.chunk_index}".encode("utf-8")).hexdigest()
    return f"chunk_{digest[:32]}"


def deterministic_embedding(text: str, dimensions: int = 16) -> list[float]:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    values = []
    for index in range(dimensions):
        byte = digest[index]
        values.append((byte / 127.5) - 1.0)
    return values


def flatten_metadata(metadata: dict) -> dict:
    flattened = {}
    for key, value in (metadata or {}).items():
        if value is None:
            continue
        if isinstance(value, (str, int, float, bool)):
            flattened[key] = value
        else:
            flattened[key] = str(value)
    return flattened


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def transition_job(
    db: Session,
    document: Document,
    job: DocumentIngestionJob,
    stage: DocumentStatus,
    progress_percent: int,
    *,
    chunks_created: int | None = None,
    chunks_embedded: int | None = None,
) -> None:
    document.status = stage.value
    job.status = IngestionJobStatus.RUNNING.value
    job.stage = stage.value
    job.progress_percent = progress_percent
    if chunks_created is not None:
        job.chunks_created = chunks_created
    if chunks_embedded is not None:
        job.chunks_embedded = chunks_embedded
    db.flush()
