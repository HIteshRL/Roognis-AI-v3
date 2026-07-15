from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, JSON, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


def new_uuid() -> str:
    return str(uuid.uuid4())


class DocumentStatus(str, enum.Enum):
    UPLOADED = "uploaded"
    QUEUED = "queued"
    PARSING = "parsing"
    STRUCTURING = "structuring"
    CLASSIFYING = "classifying"
    GRAPH_BUILDING = "graph_building"
    CHUNKING = "chunking"
    EMBEDDING = "embedding"
    INDEXED = "indexed"
    READY = "ready"
    FAILED = "failed"


class IngestionJobStatus(str, enum.Enum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class EntityType(str, enum.Enum):
    CANONICAL_CONCEPT = "CanonicalConcept"
    CONCEPT = "Concept"
    DEFINITION = "Definition"
    ACTIVITY = "Activity"
    EXPERIMENT = "Experiment"
    OBSERVATION = "Observation"
    CONCLUSION = "Conclusion"
    EXAMPLE = "Example"
    APPLICATION = "Application"
    FIGURE = "Figure"
    DIAGRAM = "Diagram"
    TABLE = "Table"
    SUMMARY = "Summary"
    LAW = "Law"
    FORMULA = "Formula"
    EXERCISE = "Exercise"
    QUESTION = "Question"
    SAFETY = "Safety"
    EXTENSION = "Extension"
    KEY_POINT = "KeyPoint"


class RelationshipType(str, enum.Enum):
    BELONGS_TO = "BELONGS_TO"
    HAS_CHILD = "HAS_CHILD"
    HAS_PARENT = "HAS_PARENT"
    RELATED_TO = "RELATED_TO"
    PREREQUISITE = "PREREQUISITE"
    ILLUSTRATED_BY = "ILLUSTRATED_BY"
    EXPLAINED_BY = "EXPLAINED_BY"
    USED_IN = "USED_IN"
    APPLICATION_OF = "APPLICATION_OF"
    EXAMPLE_OF = "EXAMPLE_OF"
    CAUSES = "CAUSES"
    RESULTS_IN = "RESULTS_IN"
    COMPARES_WITH = "COMPARES_WITH"
    NEXT_TOPIC = "NEXT_TOPIC"
    PREVIOUS_TOPIC = "PREVIOUS_TOPIC"
    REFERENCES = "REFERENCES"
    SUMMARIZED_BY = "SUMMARIZED_BY"


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )


class Document(Base, TimestampMixin):
    __tablename__ = "documents"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String(255), nullable=False)
    file_path: Mapped[str | None] = mapped_column(String(1024))
    content_type: Mapped[str | None] = mapped_column(String(120))
    file_size_bytes: Mapped[int | None] = mapped_column(Integer)
    board: Mapped[str] = mapped_column(String(40), nullable=False)
    curriculum: Mapped[str] = mapped_column(String(80), nullable=False)
    grade: Mapped[int] = mapped_column(Integer, nullable=False)
    subject: Mapped[str] = mapped_column(String(80), nullable=False)
    book: Mapped[str] = mapped_column(String(180), nullable=False)
    chapter_number: Mapped[int] = mapped_column(Integer, nullable=False)
    chapter_name: Mapped[str] = mapped_column(String(220), nullable=False)
    language: Mapped[str] = mapped_column(String(80), nullable=False)
    edition: Mapped[str] = mapped_column(String(40), nullable=False)
    difficulty: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(
        String(40),
        default=DocumentStatus.UPLOADED.value,
        nullable=False,
        index=True,
    )
    error_message: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    jobs: Mapped[list[DocumentIngestionJob]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
    )
    entities: Mapped[list[EducationalEntity]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
    )
    chunks: Mapped[list[RetrievalChunk]] = relationship(
        back_populates="document",
        cascade="all, delete-orphan",
    )

    __table_args__ = (
        Index("ix_documents_school_subject_grade", "school_id", "subject", "grade"),
        Index(
            "ix_documents_school_chapter",
            "school_id",
            "subject",
            "grade",
            "chapter_number",
        ),
    )


class DocumentIngestionJob(Base, TimestampMixin):
    __tablename__ = "document_ingestion_jobs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    status: Mapped[str] = mapped_column(
        String(40),
        default=IngestionJobStatus.QUEUED.value,
        nullable=False,
        index=True,
    )
    stage: Mapped[str] = mapped_column(
        String(40),
        default=DocumentStatus.QUEUED.value,
        nullable=False,
    )
    progress_percent: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    pages_parsed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    entities_created: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunks_created: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    chunks_embedded: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    document: Mapped[Document] = relationship(back_populates="jobs")


class EducationalEntity(Base, TimestampMixin):
    __tablename__ = "educational_entities"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    entity_type: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    canonical_concept_id: Mapped[str | None] = mapped_column(String(36), index=True)
    title: Mapped[str | None] = mapped_column(String(240))
    content: Mapped[str | None] = mapped_column(Text)
    summary: Mapped[str | None] = mapped_column(Text)
    parent_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("educational_entities.id", ondelete="SET NULL"),
        index=True,
    )
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)

    document: Mapped[Document] = relationship(back_populates="entities")
    parent: Mapped[EducationalEntity | None] = relationship(
        remote_side="EducationalEntity.id",
        back_populates="children",
    )
    children: Mapped[list[EducationalEntity]] = relationship(back_populates="parent")
    chunks: Mapped[list[RetrievalChunk]] = relationship(back_populates="entity")

    __table_args__ = (
        Index("ix_entities_school_type", "school_id", "entity_type"),
        Index("ix_entities_document_type", "document_id", "entity_type"),
    )


class EntityRelationship(Base):
    __tablename__ = "entity_relationships"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    source_entity_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("educational_entities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    target_entity_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("educational_entities.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    relationship_type: Mapped[str] = mapped_column(String(60), nullable=False, index=True)
    confidence: Mapped[float | None] = mapped_column(Float)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    __table_args__ = (
        Index(
            "ix_entity_relationship_unique_lookup",
            "source_entity_id",
            "target_entity_id",
            "relationship_type",
        ),
    )


class RetrievalChunk(Base):
    __tablename__ = "retrieval_chunks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_uuid)
    document_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("documents.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    entity_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("educational_entities.id", ondelete="SET NULL"),
        index=True,
    )
    canonical_concept_id: Mapped[str | None] = mapped_column(String(36), index=True)
    school_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    board: Mapped[str] = mapped_column(String(40), nullable=False)
    curriculum: Mapped[str] = mapped_column(String(80), nullable=False)
    subject: Mapped[str] = mapped_column(String(80), nullable=False, index=True)
    grade: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    chapter_number: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    chapter_name: Mapped[str] = mapped_column(String(220), nullable=False)
    chunk_index: Mapped[int] = mapped_column(Integer, nullable=False)
    chunk_type: Mapped[str] = mapped_column(String(60), default="semantic", nullable=False)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(320), nullable=False)
    source_page: Mapped[int | None] = mapped_column(Integer)
    page_start: Mapped[int | None] = mapped_column(Integer)
    page_end: Mapped[int | None] = mapped_column(Integer)
    vector_id: Mapped[str | None] = mapped_column(String(120), index=True)
    pedagogical_order: Mapped[int | None] = mapped_column(Integer)
    token_count: Mapped[int | None] = mapped_column(Integer)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        nullable=False,
    )

    document: Mapped[Document] = relationship(back_populates="chunks")
    entity: Mapped[EducationalEntity | None] = relationship(back_populates="chunks")

    __table_args__ = (
        Index("ix_chunks_school_subject_grade", "school_id", "subject", "grade"),
        Index(
            "ix_chunks_school_chapter",
            "school_id",
            "subject",
            "grade",
            "chapter_number",
        ),
    )
