from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = Field(
        "postgresql+psycopg://postgres:postgres@postgres:5432/roognis",
        description="SQLAlchemy database URL for the RAG schema.",
    )
    rag_db_schema: str = Field(
        "rag_db",
        description="PostgreSQL schema used by the RAG/EKE service.",
    )
    chroma_url: str = Field(
        "http://chromadb:8000",
        description="ChromaDB HTTP endpoint for retrieval chunk embeddings.",
    )
    ollama_url: str = Field(
        "http://ollama:11434",
        description="Ollama endpoint used for local embedding generation.",
    )
    ollama_embedding_model: str = Field(
        "nomic-embed-text",
        description="Ollama embedding model for EKE retrieval chunks.",
    )
    file_storage_path: str = Field(
        "/app/storage",
        description="Shared storage path for uploaded PDFs and ingestion artifacts.",
    )
    rag_max_upload_mb: int = Field(
        50,
        ge=1,
        description="Maximum accepted PDF upload size in megabytes.",
    )
    rag_collection_prefix: str = Field(
        "school",
        description="Prefix for per-school Chroma collection names.",
    )
    rag_test_mode: bool = Field(
        False,
        description="Enables lightweight test defaults for pytest/TestClient runs.",
    )

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def sqlalchemy_database_url(self) -> str:
        if self.database_url.startswith("postgresql://"):
            return self.database_url.replace("postgresql://", "postgresql+psycopg://", 1)
        return self.database_url


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
