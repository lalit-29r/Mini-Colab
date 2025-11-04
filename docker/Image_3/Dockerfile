FROM continuumio/miniconda3

LABEL org.opencontainers.image.title="Machine Learning"
LABEL org.opencontainers.image.description="Python 3.10 with numpy, pandas, matplotlib, seaborn, scikit-learn, pip."
# ------------------------------------------------------------
# Set working directory
# ------------------------------------------------------------
WORKDIR /app

# ------------------------------------------------------------
# Copy environment file first (to use Docker layer caching)
# ------------------------------------------------------------
COPY environment.yml .

# ------------------------------------------------------------
# Create the Conda environment
# ------------------------------------------------------------
RUN conda env create -f environment.yml

# ------------------------------------------------------------
# Activate conda environment automatically
# ------------------------------------------------------------
RUN echo "conda activate mini_colab-ml" >> ~/.bashrc
ENV PATH=/opt/conda/envs/mini_colab-ml/bin:$PATH

# ------------------------------------------------------------
# Default entrypoint: bash with conda env loaded
# ------------------------------------------------------------
ENTRYPOINT ["bash", "-l", "-c"]
CMD ["tail -f /dev/null"]
