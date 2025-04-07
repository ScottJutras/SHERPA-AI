# File: agentic_tests/test_suite_finance.py

from crewai import Crew, Task
from agentic_tests.agents.test_agents import test_agents
from dotenv import load_dotenv
import os

load_dotenv()

# === Task: Generate a quote based on material input ===
quote_generation_test = Task(
    description="Simulate assistant generating a quote from provided materials: '15 bundles of shingles, 10 sheets of plywood, 2 rolls of underlayment'. Check accuracy against pricing sheet.",
    expected_output="A quote PDF should be created with accurate unit prices, quantities, and calculated total.",
    tools=[],
    agent=test_agents["quote_agent"]
)

# === Task: Generate and deliver the PDF quote ===
quote_pdf_test = Task(
    description="Test PDF generation of a finalized quote and delivery to user via WhatsApp.",
    expected_output="PDF should include client name, job info, material breakdown, and total. Delivered via SendGrid or WhatsApp API.",
    tools=[],
    agent=test_agents["quote_agent"]
)

# === Create the test crew ===
quote_suite = Crew(
    agents=[test_agents["quote_agent"]],
    tasks=[quote_generation_test, quote_pdf_test],
    verbose=True
)

# === Run the test suite ===
if __name__ == "__main__":
    print("\n📊 Running Finance Quote Tests...")
    results = quote_suite.kickoff()
    print("\n✅ Finance Quote Test Results:")
    print(results)

