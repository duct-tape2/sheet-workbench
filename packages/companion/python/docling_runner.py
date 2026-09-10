"""Local-only Docling extraction bridge. It receives only a service-owned file path."""
import json
import sys


def main(file_path):
    try:
        from docling.document_converter import DocumentConverter

        result = DocumentConverter().convert(file_path)
        content = result.document.export_to_markdown()
        sys.stdout.write(json.dumps({"content": content}))
        return 0
    except Exception:
        # Do not echo filenames, document text, or stack traces to stdout/stderr.
        return 1


if __name__ == "__main__":
    if sys.argv[1:] == ["--probe"]:
        try:
            from docling.document_converter import DocumentConverter  # noqa: F401
            raise SystemExit(0)
        except Exception:
            raise SystemExit(1)
    if len(sys.argv) != 2:
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
