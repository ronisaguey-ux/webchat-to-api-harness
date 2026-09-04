"""
Data source abstraction for Oculus.
"""

class DataSource:
    def __init__(self, name):
        self.name = name

    def fetch(self, query):
        # Placeholder for actual data fetching
        return []
