class BillingError(Exception):
    """Every business error of the package; `code` says which rule failed."""

    def __init__(self, code: str, message: str = ""):
        super().__init__(f"{code}: {message}" if message else code)
        self.code = code
        self.message = message
